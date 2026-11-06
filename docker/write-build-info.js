// Writes build-info.json from the build args: node write-build-info.js <version> <branch> <commit>
const { writeFileSync } = require('fs');

const [version, branch, commit] = process.argv.slice(2);

if (!version || !branch || !commit) {
  console.error('BUILD_VERSION, BUILD_BRANCH and BUILD_COMMIT must be set together');
  process.exit(1);
}

writeFileSync('build-info.json', `${JSON.stringify({ version, branch, commit })}\n`);
