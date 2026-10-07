package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) (string, []string, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "swarm")
	if err := os.MkdirAll(filepath.Join(dir, "certificates"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "raft"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string]string{"certificates/swarm-root-ca.crt": "synthetic-root-ca", "certificates/swarm-node.crt": "synthetic-node-cert", "certificates/swarm-node.key": "synthetic-encrypted-key", "docker-state.json": "{}", "raft/synthetic-wal": "encrypted-wal"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte("synthetic-root-ca")))
	return dir, []string{"--disposable-copy", "--state-dir", dir, "--root-ca-sha256", sum}, "SWMKEY-1-" + base64.RawStdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)) + "\n"
}

func TestValidCopyRunsOnceAndPreservesCA(t *testing.T) {
	dir, args, key := fixture(t)
	var output bytes.Buffer
	calls := 0
	var used []byte
	err := execute(args, strings.NewReader(key), &output, func(o options, k []byte) error {
		calls++
		used = k
		if o.StateDir != dir || len(k) != 32 {
			t.Fatal("bad recovery options")
		}
		if _, err := os.Stat(filepath.Join(dir, intentFile)); err != nil {
			t.Fatal("missing intent before rebuild")
		}
		return nil
	})
	if err != nil || calls != 1 || !strings.Contains(output.String(), `"status":"offline-quorum-rebuilt"`) {
		t.Fatalf("result=%v calls=%d output=%s", err, calls, &output)
	}
	if bytes.Count(used, []byte{0}) != 32 {
		t.Fatal("key retained after completion")
	}
	if strings.Contains(output.String(), "SWMKEY") {
		t.Fatal("key leaked")
	}
	record, err := os.ReadFile(filepath.Join(dir, intentFile))
	if err != nil || !bytes.HasSuffix(record, output.Bytes()) {
		t.Fatal("successful completion record not retained")
	}
}

func TestMissingExplicitOptInDoesNotMutate(t *testing.T) {
	_, args, key := fixture(t)
	calls := 0
	if err := execute(args[1:], strings.NewReader(key), &bytes.Buffer{}, func(options, []byte) error { calls++; return nil }); err == nil || calls != 0 {
		t.Fatal("missing opt-in accepted")
	}
}
func TestWrongCAAndMissingStateNeverRebuild(t *testing.T) {
	for _, which := range []string{"ca", "state", "raft", "key"} {
		t.Run(which, func(t *testing.T) {
			dir, args, key := fixture(t)
			calls := 0
			switch which {
			case "ca":
				args[len(args)-1] = strings.Repeat("0", 64)
			case "state":
				os.Remove(filepath.Join(dir, "docker-state.json"))
			case "raft":
				os.RemoveAll(filepath.Join(dir, "raft"))
			case "key":
				os.Remove(filepath.Join(dir, "certificates/swarm-node.key"))
			}
			if err := execute(args, strings.NewReader(key), &bytes.Buffer{}, func(options, []byte) error { calls++; return nil }); err == nil || calls != 0 {
				t.Fatal("invalid copy accepted")
			}
		})
	}
}
func TestSymlinkAndRelativeStateNeverRebuild(t *testing.T) {
	dir, args, key := fixture(t)
	alias := filepath.Join(t.TempDir(), "alias")
	os.Symlink(dir, alias)
	for _, value := range []string{"swarm", alias} {
		args[2] = value
		calls := 0
		if err := execute(args, strings.NewReader(key), &bytes.Buffer{}, func(options, []byte) error { calls++; return nil }); err == nil || calls != 0 {
			t.Fatal("unsafe path accepted")
		}
	}
}
func TestInvalidKeysNeverReachRebuild(t *testing.T) {
	for _, key := range []string{"", "SWMKEY-1-short", strings.Repeat("a", 300), "SWMKEY-1-" + strings.Repeat("A", 43) + "\nextra"} {
		_, args, _ := fixture(t)
		calls := 0
		if err := execute(args, strings.NewReader(key), &bytes.Buffer{}, func(options, []byte) error { calls++; return nil }); err == nil || calls != 0 {
			t.Fatal("invalid key accepted")
		}
	}
}
func TestFailureLeavesIntentAndNeverEmitsSuccessOrRawError(t *testing.T) {
	dir, args, key := fixture(t)
	var output bytes.Buffer
	calls := 0
	err := execute(args, strings.NewReader(key), &output, func(options, []byte) error { calls++; return fmt.Errorf("secret upstream error") })
	if err == nil || calls != 1 || output.Len() != 0 || strings.Contains(err.Error(), "secret") {
		t.Fatal("failed rebuild became success or leaked")
	}
	if _, err := os.Stat(filepath.Join(dir, intentFile)); err != nil {
		t.Fatal("ambiguous rebuild intent lost")
	}
	if err := execute(args, strings.NewReader(key), &output, func(options, []byte) error { calls++; return nil }); err == nil || calls != 1 {
		t.Fatal("ambiguous rebuild resent")
	}
}
func TestChangedRootCARejectsCompletion(t *testing.T) {
	dir, args, key := fixture(t)
	var output bytes.Buffer
	err := execute(args, strings.NewReader(key), &output, func(options, []byte) error {
		return os.WriteFile(filepath.Join(dir, "certificates/swarm-root-ca.crt"), []byte("changed"), 0600)
	})
	if err == nil || output.Len() != 0 {
		t.Fatal("changed root accepted")
	}
	if _, err := os.Stat(filepath.Join(dir, intentFile)); err != nil {
		t.Fatal("failed invariant lost intent")
	}
}
func TestExtraArgsAndDuplicateIntentAreRejected(t *testing.T) {
	dir, args, key := fixture(t)
	os.WriteFile(filepath.Join(dir, intentFile), []byte("prior run"), 0600)
	calls := 0
	for _, a := range [][]string{args, append(args, "unexpected")} {
		if err := execute(a, strings.NewReader(key), &bytes.Buffer{}, func(options, []byte) error { calls++; return nil }); err == nil {
			t.Fatal("unsafe request accepted")
		}
	}
	if calls != 0 {
		t.Fatal("rebuild called")
	}
}

// Delivery failure must never authorize another mutation of a completed copy.
type resultWriter func([]byte) (int, error)

func (w resultWriter) Write(data []byte) (int, error) { return w(data) }

func TestOutputFailureRetainsCompletedResultAndBlocksRebuild(t *testing.T) {
	for _, written := range []int{0, 8, -1} {
		t.Run(fmt.Sprint(written), func(t *testing.T) {
			dir, args, key := fixture(t)
			calls := 0
			rebuild := func(options, []byte) error { calls++; return nil }
			writer := resultWriter(func(data []byte) (int, error) {
				n := written
				if n < 0 {
					n = len(data)
				}
				return n, fmt.Errorf("synthetic delivery error")
			})
			if err := execute(args, strings.NewReader(key), writer, rebuild); err == nil {
				t.Error("lost output was reported as success")
			}
			data, err := os.ReadFile(filepath.Join(dir, intentFile))
			if err != nil || !bytes.Contains(data, []byte(`"status":"offline-quorum-rebuilt"`)) {
				t.Error("completed result not retained after delivery failure")
			}
			if err := execute(args, strings.NewReader(key), &bytes.Buffer{}, rebuild); err == nil || calls != 1 {
				t.Errorf("delivery failure allowed rebuild: calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestCompletedResultExistsBeforeOutputDelivery(t *testing.T) {
	dir, args, key := fixture(t)
	writer := resultWriter(func(data []byte) (int, error) {
		record, err := os.ReadFile(filepath.Join(dir, intentFile))
		if err != nil || !bytes.HasSuffix(record, data) {
			t.Error("output preceded the retained completion record")
		}
		if bytes.Contains(record, []byte("SWMKEY")) {
			t.Error("completion record leaked the key")
		}
		return len(data), nil
	})
	if err := execute(args, strings.NewReader(key), writer, func(options, []byte) error { return nil }); err != nil {
		t.Fatal(err)
	}
}

func TestSuccessfulDeliveryStillBlocksSecondRebuild(t *testing.T) {
	_, args, key := fixture(t)
	calls := 0
	rebuild := func(options, []byte) error { calls++; return nil }
	if err := execute(args, strings.NewReader(key), &bytes.Buffer{}, rebuild); err != nil {
		t.Fatal(err)
	}
	if err := execute(args, strings.NewReader(key), &bytes.Buffer{}, rebuild); err == nil || calls != 1 {
		t.Fatalf("completed copy rebuilt again: calls=%d err=%v", calls, err)
	}
}

func TestReentrantOutputCannotRebuildTheSameCopy(t *testing.T) {
	_, args, key := fixture(t)
	calls := 0
	rebuild := func(options, []byte) error { calls++; return nil }
	writer := resultWriter(func(data []byte) (int, error) {
		if err := execute(args, strings.NewReader(key), &bytes.Buffer{}, rebuild); err == nil {
			t.Error("reentrant output rebuilt the copy")
		}
		return len(data), nil
	})
	if err := execute(args, strings.NewReader(key), writer, rebuild); err != nil || calls != 1 {
		t.Fatalf("result=%v calls=%d", err, calls)
	}
}

func TestShortOutputCannotReportDeliverySuccess(t *testing.T) {
	dir, args, key := fixture(t)
	writer := resultWriter(func(data []byte) (int, error) { return len(data) - 1, nil })
	if err := execute(args, strings.NewReader(key), writer, func(options, []byte) error { return nil }); err == nil {
		t.Error("short output reported success")
	}
	if _, err := os.Stat(filepath.Join(dir, intentFile)); err != nil {
		t.Error("short output lost the rebuild fence")
	}
}
