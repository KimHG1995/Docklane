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
	if _, err := os.Stat(filepath.Join(dir, intentFile)); !os.IsNotExist(err) {
		t.Fatal("successful intent not cleared")
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
