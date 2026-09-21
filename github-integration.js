// ==========================================
// GITHUB API INTEGRATION FOR UMBA AGENT
// ==========================================

const GITHUB_API_URL = 'https://api.github.com';
const GITHUB_USER_AGENT = 'Umba-SaaS-Agent';

function githubHeaders(env, includeJson = false) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': GITHUB_USER_AGENT,
    ...(includeJson ? { 'Content-Type': 'application/json' } : {})
  };
}

// GitHub's Contents API expects UTF-8 content encoded as Base64.
function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

async function readGitHubError(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  return data.message || `HTTP ${response.status}`;
}

// 1. Create a new GitHub Repository
export async function githubCreateRepo(repoName, description, env) {
  const response = await fetch(`${GITHUB_API_URL}/user/repos`, {
    method: 'POST',
    headers: githubHeaders(env, true),
    body: JSON.stringify({
      name: repoName,
      description: description || 'Created autonomously by Umba Agent',
      private: false
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub Repo Creation Failed: ${await readGitHubError(response)}`);
  }

  const data = await response.json();
  return { success: true, repoUrl: data.html_url, fullName: data.full_name };
}

// 2. Create or update a file in a GitHub repository
export async function githubCreateFile(repoFullName, filePath, fileContent, env) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const endpoint = `${GITHUB_API_URL}/repos/${repoFullName}/contents/${encodedPath}`;

  // An update requires the current blob SHA. A 404 means this is a new file.
  let sha;
  const existingResponse = await fetch(endpoint, {
    method: 'GET',
    headers: githubHeaders(env)
  });

  if (existingResponse.ok) {
    const existingFile = await existingResponse.json();
    sha = existingFile.sha;
  } else if (existingResponse.status !== 404) {
    throw new Error(`GitHub File Lookup Failed (${filePath}): ${await readGitHubError(existingResponse)}`);
  }

  const body = {
    message: `Umba Agent: ${sha ? 'Update' : 'Add'} ${filePath}`,
    content: encodeBase64(fileContent),
    ...(sha ? { sha } : {})
  };

  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: githubHeaders(env, true),
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(`GitHub File Creation Failed (${filePath}): ${await readGitHubError(response)}`);
  }

  return { success: true, path: filePath };
}

// 3. Commit multiple files sequentially through the Contents API
export async function githubCommitMultipleFiles(repoFullName, files, env) {
  const results = [];

  for (const file of files) {
    results.push(await githubCreateFile(repoFullName, file.path, file.content, env));
  }

  return { success: true, committedFiles: results.length, files: results };
}

// Plan execution handler
export async function executePlan(plan, env) {
  const startTime = Date.now();
  const executionLogs = [];
  let createdRepoUrl = '';

  for (const op of plan.operations || []) {
    try {
      if (op.type === 'github_create_repo') {
        const result = await githubCreateRepo(op.params.name, op.params.description, env);
        createdRepoUrl = result.repoUrl;
        executionLogs.push(`✅ Created GitHub Repo: ${result.repoUrl}`);
      } else if (op.type === 'github_create_file') {
        await githubCreateFile(op.params.repo, op.params.path, op.params.content, env);
        executionLogs.push(`✅ Created File: ${op.params.path}`);
      } else if (op.type === 'github_commit_multiple_files') {
        const result = await githubCommitMultipleFiles(op.params.repo, op.params.files, env);
        executionLogs.push(`✅ Committed ${result.committedFiles} GitHub files`);
      } else {
        executionLogs.push(`⚠️ Unsupported operation: ${op.type}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executionLogs.push(`❌ Error in ${op.type}: ${message}`);
    }
  }

  return {
    time: `${((Date.now() - startTime) / 1000).toFixed(2)} seconds`,
    repoUrl: createdRepoUrl,
    logs: executionLogs
  };
}
