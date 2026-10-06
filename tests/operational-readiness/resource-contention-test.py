#!/usr/bin/env python3
"""Readiness regressions using the real harness functions, without a Docker daemon."""
from __future__ import annotations

import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
GOOD = ('manager-01|Ready|Active|Leader\n'
        'manager-02|Ready|Active|Reachable\n'
        'manager-03|Ready|Active|Reachable\n')
BAD = GOOD.replace('manager-03|Ready|Active|Reachable',
                   'manager-03|Unknown|Active|Unreachable')


class ContentionReadinessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='docklane-contention-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        source = (HERE / 'resource-contention.sh').read_text()
        boundary = '\n[[ -n "$AGENT_BINARY"'
        self.assertEqual(source.count(boundary), 1)
        self.functions = self.root / 'functions.sh'
        self.functions.write_text(source.split(boundary, 1)[0])
        self.output = self.root / 'topology.txt'
        self.count = self.root / 'observations'
        self.sleeps = self.root / 'sleeps'
        (self.root / 'good.txt').write_text(GOOD)

    def run_harness(self, first=BAD, fail_count=1, status=0, assertion=False, conditional=False):
        (self.root / 'first.txt').write_text(first)
        function = 'assert_three_managers_ready' if assertion else 'wait_three_managers_ready'
        call = f'{function} manager-01 {shlex.quote(str(self.output))}'
        if conditional:
            call = f'if {call}; then echo ACCEPTED; else echo REJECTED; fi'
        body = f'''source {shlex.quote(str(self.functions))}
observations=0
docker() {{
  [[ "$*" == "exec manager-01 docker node ls --format "* ]] || return 90
  observations=$((observations + 1))
  printf '%s' "$observations" > "$FIXTURE_ROOT/observations"
  if (( observations <= FAIL_COUNT )); then
    cat "$FIXTURE_ROOT/first.txt"
    return "$FIXTURE_STATUS"
  fi
  cat "$FIXTURE_ROOT/good.txt"
}}
sleep() {{ printf '%s\\n' "$1" >> "$FIXTURE_ROOT/sleeps"; }}
{call}
echo CONTINUED
'''
        env = dict(os.environ, FIXTURE_ROOT=str(self.root),
                   FAIL_COUNT=str(fail_count), FIXTURE_STATUS=str(status),
                   DOCKLANE_OR_LOG_DIR=str(self.root / 'evidence'))
        return subprocess.run(['bash', '-c', body], env=env, capture_output=True,
                              text=True, timeout=10)

    def observations(self):
        return int(self.count.read_text())

    def test_transient_nonready_retries_then_accepts_the_new_snapshot(self):
        result = self.run_harness()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.observations(), 2)
        self.assertEqual(self.output.read_text(), GOOD)
        self.assertEqual(self.sleeps.read_text().splitlines(), ['1'])
        self.assertIn('CONTINUED', result.stdout)

    def test_each_quorum_condition_remains_pending_until_satisfied(self):
        variants = ('', '\n'.join(GOOD.splitlines()[:2]) + '\n',
                    GOOD.replace('|Active|', '|Drain|', 1),
                    GOOD.replace('|Leader', '|Reachable'),
                    GOOD.replace('manager-02|Ready|Active|Reachable', 'manager-02|Ready|Active|Leader'),
                    GOOD.replace('manager-03|Ready|Active|Reachable', 'manager-03|Ready|Active|'),
                    'unexpected topology\n')
        for first in variants:
            with self.subTest(first=first):
                result = self.run_harness(first)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.observations(), 2)
                self.assertEqual(self.output.read_text(), GOOD)

    def test_failed_capture_cannot_authorize_even_valid_looking_output(self):
        result = self.run_harness(first=GOOD, status=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.observations(), 2)
        self.assertEqual(self.output.read_text(), GOOD)

    def test_retry_budget_exhaustion_fails_after_all_observations(self):
        result = self.run_harness(fail_count=120)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.observations(), 120)
        self.assertIn('three-manager Swarm did not converge', result.stderr)
        self.assertNotIn('CONTINUED', result.stdout)

    def test_capture_errors_exhaust_budget_instead_of_reporting_ready(self):
        result = self.run_harness(first=GOOD, fail_count=120, status=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.observations(), 120)
        self.assertIn('three-manager Swarm did not converge', result.stderr)
        self.assertNotIn('CONTINUED', result.stdout)

    def test_ready_first_observation_does_not_sleep(self):
        result = self.run_harness(fail_count=0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.observations(), 1)
        self.assertFalse(self.sleeps.exists())

    def test_pressure_assertion_still_exits_immediately_when_nonready(self):
        result = self.run_harness(assertion=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.observations(), 1)
        self.assertFalse(self.sleeps.exists())
        self.assertNotIn('CONTINUED', result.stdout)

    def test_pressure_assertion_does_not_ignore_failed_capture_in_a_conditional(self):
        result = self.run_harness(first=GOOD, status=1, assertion=True, conditional=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.observations(), 1)
        self.assertNotIn('ACCEPTED', result.stdout)
        self.assertNotIn('CONTINUED', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
