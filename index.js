const fs = require('fs').promises;
const path = require('path');
const fetch = require('node-fetch-native');
const core = require('@actions/core');
const { default: artifactClient} = require('@actions/artifact');
const { createArtifacts } = require('@bundle-stats/cli-utils');
const { createJobs, createReport } = require('@bundle-stats/utils');
const { filter, validate } = require('@bundle-stats/utils/lib/webpack');

const { GITHUB_REPOSITORY, GITHUB_SHA } = process.env;

async function getWebpackData(statsPath) {
  if (!statsPath) {
    return undefined;
  }

  core.debug(`Read webpack stats file from ${statsPath}`);
  const content = await fs.readFile(statsPath, 'utf8');
  const source = JSON.parse(content);

  core.debug('Filter webpack stats');
  const data = filter(source);

  core.debug('Validate webpack stats');
  const invalid = validate(data);
  if (invalid) {
    core.setFailed(`Failed: ${invalid}`);
    return core.warning(invalid);
  }

  return { webpack: data };
}

(async () => {
  const id = core.getInput('id', { required: false });
  const statsPath = core.getInput('webpack-stats-path', { required: true });
  const statsBaselinePath = core.getInput('webpack-stats-baseline-path', { required: false });
  const token = core.getInput('repo-token', { required: false });
  const skipArtifactUpload = core.getInput('skip-artifact-upload', { required: false }) == 'true';

  const runId = ['bundle-stats', id].filter(Boolean).join(' / ');
  const runArtifact = ['bundle-stats', id].filter(Boolean).join('-');

  try {
    const data = [await getWebpackData(statsPath)];
    const baseline = await getWebpackData(statsBaselinePath);
    if (baseline) {
      data.push(baseline);
    }

    const jobs = createJobs(data);

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
      core.setFailed('Failed to write artifact files');
      return;
    }

    if (!skipArtifactUpload) {
      await artifactClient.uploadArtifact(runArtifact, files, outDir);
    }

    const textInfo = report?.insights?.webpack?.assetsSizeTotal?.data?.text;
    const markdownInfo = report?.insights?.webpack?.assetsSizeTotal?.data?.md;

    if (!textInfo) {
      core.warning(`Something went wrong, no information available.`);
      core.setFailed('Failed to report bundle size');
      return;
    }

    if (token) {
      await fetch(
        `https://api.github.com/repos/${GITHUB_REPOSITORY}/statuses/${GITHUB_SHA}`,
        {
          method: 'post',
          body: JSON.stringify({
            state: 'success',
            context: runId,
            description: textInfo
          }),
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          }
        }
      );
    } else {
      core.warning(`Could set action status. Total Bundle Size: ${textInfo}`);
    }

    core.setOutput('files', files.map(file => `"${file}"`).join(' '));
    core.setOutput('runId', runId);
    core.setOutput('info', textInfo);
    core.setOutput('markdownInfo', markdownInfo);
    core.setOutput('jsonInfo', JSON.stringify(report?.insights?.webpack?.assetsSizeTotal?.data?.info));
  } catch (error) {
    core.setFailed('Failed to report bundle size');
    return core.error(error.stack ? error.stack : error.message);
  }
})();
