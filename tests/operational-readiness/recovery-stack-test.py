#!/usr/bin/env python3
"""Deterministic stack-boundary regressions; no Docker or raw CI logs needed."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("recovery_diagnostics", HERE / "recovery-diagnostics.py")
DIAGNOSTICS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIAGNOSTICS)

# Synthetic call sites: distinct names/lines make cross-goroutine merges visible.
def stack(header: str, function: str, line: int) -> str:
    return (f"{header}\n{function}(0xcafebabe, 0x123456)\n"
            f"\t/synthetic/runtime/frame.go:{line} +0xabc\n")


class StackBoundaryTests(unittest.TestCase):
    def assert_separate(self, header: str, state: str) -> None:
        text = (stack("goroutine 1 [chan receive]:", "runtime.first", 11)
                + stack(header, "sync.second", 22)
                + stack("goroutine 3 [select]:", "runtime.third", 33))
        self.assertEqual(DIAGNOSTICS.stack_summary(text), [
            {"state": "chan receive", "frames": [{"function": "runtime.first", "file": "frame.go", "line": 11}]},
            {"state": state, "frames": [{"function": "sync.second", "file": "frame.go", "line": 22}]},
            {"state": "select", "frames": [{"function": "runtime.third", "file": "frame.go", "line": 33}]},
        ])

    def test_dotted_wait_states_stay_in_separate_goroutines(self):
        for state in ("sync.WaitGroup.Wait", "sync.Mutex.Lock", "sync.RWMutex.RLock",
                      "sync.RWMutex.Lock", "sync.Cond.Wait"):
            with self.subTest(state=state):
                self.assert_separate(f"goroutine 2 [{state}]:", state)

    def test_parenthesized_wait_states_stay_in_separate_goroutines(self):
        for state in ("force gc (idle)", "chan receive (nil chan)", "select (no cases)",
                      "GC worker (idle)", "sync.WaitGroup.Wait (durable)"):
            with self.subTest(state=state):
                self.assert_separate(f"goroutine 2 [{state}]:", state)

    def test_header_metadata_is_not_copied_into_state(self):
        for suffix in (", 2 minutes", ", locked to thread", ", 2 minutes, locked to thread"):
            with self.subTest(suffix=suffix):
                self.assert_separate(f"goroutine 2 [sync.WaitGroup.Wait{suffix}]:", "sync.WaitGroup.Wait")

    def test_unrecognized_headers_discard_frames_until_next_valid_header(self):
        key = "SWMKEY-1-" + "X" * 43
        for header in (
            "goroutine 2 [new/state]:",
            "goroutine 2 [sync.WaitGroup.Wait",  # truncated header
            "goroutine malformed [select]:",
            "goroutine 2 gp=0x123456 m=7 mp=0xcafebabe [running]:",
            f"goroutine 2 [select, labels:{{key: {key}}}]:",
            "goroutine 2 [-----BEGIN PRIVATE KEY-----]:",
            "goroutine 2 [" + "A" * 1000 + "]:",
        ):
            with self.subTest(header=header):
                text = (stack("goroutine 1 [chan receive]:", "runtime.first", 11)
                        + stack(header, "runtime.discarded", 22)
                        + stack("goroutine 3 [select]:", "runtime.third", 33))
                summary = DIAGNOSTICS.stack_summary(text)
                self.assertEqual(summary, [
                    {"state": "chan receive", "frames": [{"function": "runtime.first", "file": "frame.go", "line": 11}]},
                    {"state": "select", "frames": [{"function": "runtime.third", "file": "frame.go", "line": 33}]},
                ])
                for raw in (key, "PRIVATE KEY", "0x123456", "0xcafebabe", "runtime.discarded"):
                    self.assertNotIn(raw, json.dumps(summary))

    def test_orphan_locations_after_rejected_header_do_not_attach(self):
        text = ("goroutine 1 [chan receive]:\nruntime.first(0x123456)\n"
                "goroutine 2 [unsupported/state]:\n\t/synthetic/other.go:999 +0xabc\n"
                "runtime.discarded(0x123456)\n\t/synthetic/other.go:888 +0xabc\n")
        self.assertEqual(DIAGNOSTICS.stack_summary(text), [
            {"state": "chan receive", "frames": [{"function": "runtime.first"}]},
        ])

    def test_supported_header_with_no_allowed_frames_is_not_merged(self):
        text = (stack("goroutine 1 [chan receive]:", "runtime.first", 11)
                + stack("goroutine 2 [sync.WaitGroup.Wait]:", "example.com/private.wait", 22)
                + stack("goroutine 3 [sync.Mutex.Lock]:", "sync.third", 33))
        self.assertEqual(DIAGNOSTICS.stack_summary(text), [
            {"state": "chan receive", "frames": [{"function": "runtime.first", "file": "frame.go", "line": 11}]},
            {"state": "sync.Mutex.Lock", "frames": [{"function": "sync.third", "file": "frame.go", "line": 33}]},
        ])

    def test_keeps_function_locations_without_secrets(self):
        text = ("goroutine 1 [sync.WaitGroup.Wait]:\n"
                "sync.(*WaitGroup).Wait(0xcafebabe, SWMKEY-1-synthetic, SWMTKN-1-synthetic)\n"
                "\t/private/synthetic/waitgroup.go:123 +0xabc\n"
                "-----BEGIN PRIVATE KEY-----\nprivate-data\n-----END PRIVATE KEY-----\n")
        self.assertEqual(DIAGNOSTICS.stack_summary(text), [
            {"state": "sync.WaitGroup.Wait", "frames": [{"function": "sync.(*WaitGroup).Wait", "file": "waitgroup.go", "line": 123}]},
        ])

    def test_goroutine_limit_does_not_mix_final_entry(self):
        text = "".join(stack(f"goroutine {i} [chan receive]:", f"runtime.frame{i}", i)
                       for i in range(1, 257))
        text += stack("goroutine 257 [sync.WaitGroup.Wait]:", "sync.discarded", 999)
        summary = DIAGNOSTICS.stack_summary(text)
        self.assertEqual(len(summary), 256)
        self.assertEqual(summary[-1]["frames"], [
            {"function": "runtime.frame256", "file": "frame.go", "line": 256},
        ])

    def test_frame_limit_does_not_hide_next_header(self):
        text = "goroutine 1 [chan receive]:\n" + "".join(
            f"runtime.frame{i}(0x123456)\n\t/synthetic/frame.go:{i} +0xabc\n"
            for i in range(1, 42))
        text += stack("goroutine 2 [sync.WaitGroup.Wait]:", "sync.second", 222)
        summary = DIAGNOSTICS.stack_summary(text)
        self.assertEqual(len(summary), 2)
        self.assertEqual(len(summary[0]["frames"]), 40)
        self.assertEqual(summary[0]["frames"][-1]["line"], 40)
        self.assertEqual(summary[1], {
            "state": "sync.WaitGroup.Wait", "frames": [{"function": "sync.second", "file": "frame.go", "line": 222}],
        })


if __name__ == "__main__":
    unittest.main(verbosity=2)
