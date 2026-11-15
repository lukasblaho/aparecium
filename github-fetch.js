// Shared helper: fetches a file from GitHub (public or private repos).
// GitHub render URLs reuse the Azure DevOps param names so the render pages
// need no new plumbing:
//   provider=github  org=<owner>  repo=<repo>  path=<file path>
//   branch=<ref>  (blob view)   or   prId=<number>  (pull request view)
// The token (optional for public repos) lives in chrome.storage.sync `ghToken`.

const GITHUB_API = 'https://api.github.com';

function isGitHubParams(params) {
  return params.get('provider') === 'github';
}

function ghEncodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// Human-facing github.com URL for the file (or the PR's files tab for PRs).
function githubSourceUrl(params, pathOverride) {
  const base = `https://github.com/${encodeURIComponent(params.get('org'))}/${encodeURIComponent(params.get('repo'))}`;
  const prId = params.get('prId');
  if (prId) return `${base}/pull/${encodeURIComponent(prId)}/files`;
  const ref = params.get('branch') || 'HEAD';
  return `${base}/blob/${ref.split('/').map(encodeURIComponent).join('/')}/${ghEncodePath(pathOverride ?? params.get('path'))}`;
}

// Query string for opening another file of the same repo/ref in a render page.
function githubRenderQuery(params, path) {
  let q = `?provider=github&org=${encodeURIComponent(params.get('org'))}` +
    `&repo=${encodeURIComponent(params.get('repo'))}&path=${encodeURIComponent(path)}`;
  const prId = params.get('prId');
  const branch = params.get('branch');
  if (prId) q += `&prId=${encodeURIComponent(prId)}`;
  else if (branch) q += `&branch=${encodeURIComponent(branch)}`;
  return q;
}

async function fetchGitHubFile(params) {
  const owner = params.get('org');
  const repo = params.get('repo');
  const path = params.get('path');
  const prId = params.get('prId');
  let ref = params.get('branch');

  const { ghToken = '' } = await chrome.storage.sync.get(['ghToken']);
  const auth = ghToken ? { Authorization: `Bearer ${ghToken}` } : {};

  let fullName = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let commitId = null;

  if (prId) {
    // Pin to the PR head commit (which may live in a fork).
    const prUrl = `${GITHUB_API}/repos/${fullName}/pulls/${encodeURIComponent(prId)}`;
    const prResp = await fetch(prUrl, { headers: { Accept: 'application/vnd.github+json', ...auth } });
    if (!prResp.ok) {
      throw new Error(`Could not fetch PR #${prId}: HTTP ${prResp.status} ${prResp.statusText}${ghHint(prResp.status, !!ghToken)}`);
    }
    const pr = await prResp.json();
    ref = pr.head.sha;
    commitId = pr.head.sha;
    if (pr.head.repo?.full_name) fullName = pr.head.repo.full_name.split('/').map(encodeURIComponent).join('/');
  }

  // With a token use the contents API (works for private repos); without one
  // use raw.githubusercontent.com, which has no API rate limit for public files.
  const apiUrl = ghToken
    ? `${GITHUB_API}/repos/${fullName}/contents/${ghEncodePath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`
    : `https://raw.githubusercontent.com/${fullName}/${ref ? ref.split('/').map(encodeURIComponent).join('/') : 'HEAD'}/${ghEncodePath(path)}`;
  const resp = await fetch(apiUrl, ghToken ? { headers: { Accept: 'application/vnd.github.raw+json', ...auth } } : {});
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}${ghHint(resp.status, !!ghToken)}\nFetched: ${apiUrl}`);
  }
  return { text: await resp.text(), apiUrl, commitId };
}

function ghHint(status, hasToken) {
  if (status === 401) return ' — your GitHub token is invalid or expired (check the extension popup).';
  if (status === 403) return ' — access denied or rate limit reached' + (hasToken ? '.' : '; add a GitHub token in the extension popup.');
  if (status === 404) return hasToken
    ? ' — not found (does your token have access to this repo? Fine-grained tokens need Contents: Read).'
    : ' — not found. If this is a private repo, add a GitHub token in the extension popup.';
  return '';
}
