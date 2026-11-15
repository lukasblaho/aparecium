// Shared helper: lists every renderable file of the current repo/ref (GitHub or
// Azure DevOps) and draws it as a collapsible tree with a filter box.
// Depends on github-fetch.js (isGitHubParams, githubRenderQuery) being loaded first.

const REPO_TREE_PAGES = {
  md: 'render-md.html',
  puml: 'render-puml.html', plantuml: 'render-puml.html',
  mmd: 'render-mermaid.html', mermaid: 'render-mermaid.html',
  graphql: 'render-graphql.html', gql: 'render-graphql.html',
  yaml: 'render-openapi.html', yml: 'render-openapi.html', json: 'render-openapi.html',
};

// yaml/json files are everywhere (package.json, CI configs…), so only list the ones that look like API specs.
function repoTreeIsRenderable(path) {
  const name = path.split('/').pop();
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (!REPO_TREE_PAGES[ext]) return false;
  if (REPO_TREE_PAGES[ext] === 'render-openapi.html') return /openapi|swagger/i.test(name);
  return true;
}

function repoTreeRenderUrl(params, path) {
  const ext = path.split('.').pop().toLowerCase();
  const page = chrome.runtime.getURL(REPO_TREE_PAGES[ext]);
  if (isGitHubParams(params)) return page + githubRenderQuery(params, path);
  let q = `?org=${encodeURIComponent(params.get('org'))}&project=${encodeURIComponent(params.get('project'))}` +
    `&repo=${encodeURIComponent(params.get('repo'))}&path=${encodeURIComponent(path)}`;
  if (params.get('prId')) q += `&prId=${encodeURIComponent(params.get('prId'))}`;
  else if (params.get('branch')) q += `&branch=${encodeURIComponent(params.get('branch'))}`;
  return page + q;
}

async function fetchRepoFilePaths(params, pat, commitId) {
  if (isGitHubParams(params)) return fetchGitHubPaths(params, commitId);
  const base = `https://dev.azure.com/${encodeURIComponent(params.get('org'))}/${encodeURIComponent(params.get('project'))}`;
  let version = '';
  if (commitId) version = `&versionDescriptor.version=${commitId}&versionDescriptor.versionType=commit`;
  else if (params.get('branch')) version = `&versionDescriptor.version=${encodeURIComponent(params.get('branch'))}&versionDescriptor.versionType=branch`;
  const url = `${base}/_apis/git/repositories/${encodeURIComponent(params.get('repo'))}/items` +
    `?scopePath=/&recursionLevel=Full&api-version=7.1${version}`;
  const resp = await fetch(url, { headers: pat ? { Authorization: 'Basic ' + btoa(':' + pat) } : {} });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const { value = [] } = await resp.json();
  return value.filter(i => !i.isFolder && i.gitObjectType !== 'tree').map(i => i.path.replace(/^\/+/, ''));
}

async function fetchGitHubPaths(params, commitId) {
  const { ghToken = '' } = await chrome.storage.sync.get(['ghToken']);
  const headers = { Accept: 'application/vnd.github+json', ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}) };
  let fullName = `${encodeURIComponent(params.get('org'))}/${encodeURIComponent(params.get('repo'))}`;
  let ref = params.get('branch') || 'HEAD';
  if (params.get('prId')) {
    // PR head commit, which may live in a fork
    const pr = await fetch(`${GITHUB_API}/repos/${fullName}/pulls/${encodeURIComponent(params.get('prId'))}`, { headers });
    if (!pr.ok) throw new Error(`HTTP ${pr.status}`);
    const data = await pr.json();
    ref = data.head.sha;
    if (data.head.repo?.full_name) fullName = data.head.repo.full_name.split('/').map(encodeURIComponent).join('/');
  }
  const resp = await fetch(`${GITHUB_API}/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return { paths: data.tree.filter(n => n.type === 'blob').map(n => n.path), truncated: !!data.truncated };
}

// Cached per repo + ref so navigating between files doesn't refetch the listing.
async function loadRepoFiles(params, pat, commitId) {
  const key = 'repoTree:' + [params.get('provider'), params.get('org'), params.get('project'), params.get('repo'),
    params.get('prId') || params.get('branch') || 'HEAD'].join('|');
  try { const c = sessionStorage.getItem(key); if (c) return JSON.parse(c); } catch {}
  let res = await fetchRepoFilePaths(params, pat, commitId);
  if (Array.isArray(res)) res = { paths: res, truncated: false };
  const out = { files: res.paths.filter(repoTreeIsRenderable).sort((a, b) => a.localeCompare(b)), truncated: res.truncated };
  try { sessionStorage.setItem(key, JSON.stringify(out)); } catch {}
  return out;
}

function buildRepoTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split('/');
    let node = root;
    parts.slice(0, -1).forEach((seg, i) => {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      node = node.dirs.get(seg);
    });
    node.files.push({ name: parts[parts.length - 1], path: f });
  }
  return root;
}

const REPO_TREE_SVG = {
  chev: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
};
const repoTreeIc = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${REPO_TREE_SVG[n]}</svg>`;

// Draws the "Files" section into `container`. Folders on the path to `currentPath` start open.
async function initRepoTree(container, params, pat, currentPath, commitId) {
  let data;
  try { data = await loadRepoFiles(params, pat, commitId); } catch { return; }
  if (!data.files.length) return;

  container.className = 'rt';
  container.innerHTML = '<div class="toc-title"><span>FILES IN REPO</span></div>' +
    '<input class="rt-filter" type="search" placeholder="Filter files…" aria-label="Filter files">' +
    '<div class="rt-list"></div>' +
    (data.truncated ? '<div class="rt-note">Repository is large — listing may be incomplete.</div>' : '');
  const list = container.querySelector('.rt-list');
  const filter = container.querySelector('.rt-filter');
  const open = new Set();
  const segs = currentPath.replace(/^\/+/, '').split('/');
  segs.slice(0, -1).forEach((_, i) => open.add(segs.slice(0, i + 1).join('/')));
  const current = segs.join('/');

  const draw = () => {
    const q = filter.value.trim().toLowerCase();
    const files = q ? data.files.filter(f => f.toLowerCase().includes(q)) : data.files;
    const root = buildRepoTree(files);
    list.textContent = '';
    if (!files.length) { list.innerHTML = '<div class="rt-note">No matching files.</div>'; return; }
    const walk = (node, depth, parent) => {
      for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const isOpen = q || open.has(d.path);
        const row = document.createElement('a');
        row.href = '#';
        row.className = 'rt-dir' + (isOpen ? ' expanded' : '');
        row.style.paddingLeft = `${4 + depth * 14}px`;
        row.innerHTML = `<span class="rt-chev">${repoTreeIc('chev')}</span>${repoTreeIc('folder')}<span class="t"></span>`;
        row.querySelector('.t').textContent = d.name;
        row.addEventListener('click', e => { e.preventDefault(); open.has(d.path) ? open.delete(d.path) : open.add(d.path); draw(); });
        parent.appendChild(row);
        if (isOpen) walk(d, depth + 1, parent);
      }
      for (const f of node.files) {
        const row = document.createElement('a');
        row.href = repoTreeRenderUrl(params, f.path);
        row.className = 'rt-file' + (f.path === current ? ' active' : '');
        row.style.paddingLeft = `${4 + depth * 14}px`;
        row.title = f.path;
        row.innerHTML = `<span class="rt-chev"></span>${repoTreeIc('file')}<span class="t"></span>`;
        row.querySelector('.t').textContent = f.name;
        parent.appendChild(row);
      }
    };
    walk(root, 0, list);
  };
  filter.addEventListener('input', draw);
  draw();
}
