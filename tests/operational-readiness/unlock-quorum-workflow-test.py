#!/usr/bin/env python3
"""Check expression scope and matching probe/cleanup artifact paths without YAML dependencies."""
from pathlib import Path
import re
import unittest

WORKFLOW = Path(__file__).resolve().parents[2] / '.github/workflows/operational-readiness-unlock-quorum.yml'
LOG_PATH = '${{ runner.temp }}/docklane-unlock-quorum-probe'


class WorkflowScopeTests(unittest.TestCase):
    def test_runner_context_is_not_evaluated_before_runtime_steps(self):
        text = WORKFLOW.read_text()
        before_steps, steps = text.split('    steps:\n', 1)
        self.assertNotRegex(before_steps, r'\$\{\{\s*runner\.')
        self.assertIn("DOCKLANE_OR_DISPOSABLE_HOST: '1'", before_steps)
        self.assertNotIn('pull_request:', before_steps)
        self.assertIn('if-no-files-found: error', steps)

    def test_probe_and_always_cleanup_use_the_same_step_scoped_log_path(self):
        text = WORKFLOW.read_text()
        blocks = re.split(r'^      - name: ', text, flags=re.MULTILINE)[1:]
        run = next(block for block in blocks if block.startswith('Run differential probe'))
        cleanup = next(block for block in blocks if block.startswith('Cleanup owned probe'))
        upload = next(block for block in blocks if block.startswith('Upload sanitized probe'))
        for block in (run, cleanup):
            self.assertIn('        env:\n          DOCKLANE_OR_LOG_DIR: ' + LOG_PATH, block)
        self.assertIn('if: always()', cleanup)
        self.assertIn('--cleanup-only', cleanup)
        self.assertIn('if: always()', upload)
        self.assertIn(LOG_PATH + '/unlock-quorum-probe.json', upload)
        self.assertIn(LOG_PATH + '/unlock-quorum-pending.json', upload)


if __name__ == '__main__':
    unittest.main(verbosity=2)
