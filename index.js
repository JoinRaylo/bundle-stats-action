const fs = require('fs').promises;
const path = require('path');
const got = import('got');
const core = require('@actions/core');
const { default: artifactClient} = require('@actions/artifact');
const { createArtifacts } = require('@bundle-stats/cli-utils');
const { createJobs, createReport } = require('@bundle-stats/utils');
const { filter, validate } = require('@bundle-stats/utils/lib/webpack');

const { GITHUB_REPOSITORY, GITHUB_SHA } = process.env;

(async () => {
  const id = core.getInput('id', { required: false });
  const statsPath = core.getInput('webpack-stats-path', { required: true });
  const token = core.getInput('repo-token', { required: false });

  const runId = ['bundle-stats', id].filter(Boolean).join(' / ');
  const runArtifact = ['bundle-stats', id].filter(Boolean).join('-');

  try {
    core.debug(`Read webpack stats file from ${statsPath}`);
    const content = await fs.readFile(statsPath, 'utf8');
    const source = JSON.parse(content);

    core.debug('Filter webpack stats');
    const data = filter(source);

    core.debug('Validate webpack stats');
    const invalid = validate(data);
    if (invalid) {
      return core.warning(invalid);
    }

    const jobs = createJobs([{ webpack: data }]);

    core.debug('Generate report');
    const report = createReport(jobs);

    core.debug('Generate artifacts');
    const artifactsByType = createArtifacts(jobs, report, { html: true, json: true });
    const artifacts = Object.values(artifactsByType);

    const outDir = path.join(__dirname);
    core.debug(outDir);

    core.debug('Save artifacts');

    let files = [];

    try {
      files = await Promise.all(
        artifacts.map(async ({ filename, output }) => {
          const fullFilename = path.join(outDir, filename);
          core.debug('Filename: ' + fullFilename);

          await fs.writeFile(fullFilename, output)
          return fullFilename;
        })
      );
    } catch (err) {
      core.error(err.message);
    }


    await artifactClient.uploadArtifact(runArtifact, files, outDir);

    const info = report?.insights?.webpack?.assetsSizeTotal?.data?.info?.displayValue;

    if (!info) {
      core.warning(`Something went wrong, no information available.`);
      return;
    }

    if (token) {
      await got.post(
        `https://api.github.com/repos/${GITHUB_REPOSITORY}/statuses/${GITHUB_SHA}`,
        {
          json: {
            state: 'success',
            context: runId,
            description: info
          },
          responseType: 'json',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          }
        }
      );
    } else {
      core.warning(`Total Bundle Size: ${info}`);
    }
  } catch (error) {
    return core.error(error.stack ? error.stack : error.message);
  }
})();
