package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const intentFile = ".docklane-offline-rebuild.intent"

type options struct{ StateDir string }

func digest(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("required state file unavailable")
	}
	return fmt.Sprintf("%x", sha256.Sum256(data)), nil
}

func execute(args []string, input io.Reader, output io.Writer, rebuild func(options, []byte) error) error {
	flags := flag.NewFlagSet("cold-recovery", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	confirm := flags.Bool("disposable-copy", false, "only a stopped disposable copy")
	root := flags.String("state-dir", "", "absolute path to stopped copied Swarm state")
	expected := flags.String("root-ca-sha256", "", "expected root CA fingerprint")
	if err := flags.Parse(args); err != nil {
		return errors.New("invalid recovery arguments")
	}
	if !*confirm || flags.NArg() != 0 || !filepath.IsAbs(*root) || filepath.Clean(*root) != *root {
		return errors.New("explicit disposable copy and absolute clean path required")
	}
	canonical, err := filepath.EvalSymlinks(*root)
	if err != nil || canonical != *root {
		return errors.New("state path must exist without symlinks")
	}
	sum, err := hex.DecodeString(*expected)
	if err != nil || len(sum) != 32 || strings.ToLower(*expected) != *expected {
		return errors.New("expected CA fingerprint required")
	}
	for _, name := range []string{"certificates/swarm-root-ca.crt", "certificates/swarm-node.crt", "certificates/swarm-node.key", "docker-state.json"} {
		path := filepath.Join(*root, name)
		resolved, e := filepath.EvalSymlinks(path)
		st, se := os.Lstat(path)
		if e != nil || resolved != path || se != nil || !st.Mode().IsRegular() || st.Size() == 0 {
			return errors.New("required copied state missing or unsafe")
		}
	}
	st, err := os.Lstat(filepath.Join(*root, "raft"))
	if err != nil || !st.IsDir() {
		return errors.New("existing Raft state required")
	}
	entries, err := os.ReadDir(filepath.Join(*root, "raft"))
	if err != nil || len(entries) == 0 {
		return errors.New("empty Raft state is not a backup")
	}
	ca := filepath.Join(*root, "certificates/swarm-root-ca.crt")
	before, err := digest(ca)
	if err != nil || before != *expected {
		return errors.New("root CA does not match backup")
	}
	raw, err := io.ReadAll(io.LimitReader(input, 257))
	if err != nil || len(raw) > 256 {
		return errors.New("invalid unlock key input")
	}
	defer clear(raw)
	text := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(text, "SWMKEY-1-") {
		return errors.New("invalid unlock key encoding")
	}
	encoded := strings.TrimPrefix(text, "SWMKEY-1-")
	key, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 || base64.RawStdEncoding.EncodeToString(key) != encoded {
		return errors.New("invalid unlock key encoding")
	}
	defer clear(key)
	// Retain this fence after failure AND completion. A lost result must never
	// authorize another rebuild on the same copy.
	marker := filepath.Join(*root, intentFile)
	record, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("prior or concurrent rebuild intent exists")
	}
	defer record.Close()
	_, err = record.WriteString("moby-v28.5.2 isolated offline rebuild\n")
	if err == nil {
		err = record.Sync()
	}
	if err != nil {
		return errors.New("could not persist rebuild intent")
	}
	directory, err := os.Open(*root)
	if err != nil {
		return errors.New("could not persist rebuild intent")
	}
	err = directory.Sync()
	directory.Close()
	if err != nil {
		return errors.New("could not persist rebuild intent")
	}
	if rebuild == nil || rebuild(options{StateDir: *root}, key) != nil {
		return errors.New("offline rebuild did not complete; discard working copy")
	}
	after, err := digest(ca)
	if err != nil || after != before {
		return errors.New("root CA changed during rebuild; discard working copy")
	}
	// Persist the exact result on the already-exclusive descriptor before stdout.
	// Failed writes/sync/close retain the fence, even if the journal is partial.
	result, err := json.Marshal(map[string]any{"status": "offline-quorum-rebuilt", "root_ca_preserved": true, "single_backup_acceptance": false})
	if err != nil {
		return errors.New("could not encode rebuild completion")
	}
	result = append(result, '\n')
	if _, err := record.Write(result); err != nil {
		return errors.New("could not persist rebuild completion; rebuild remains blocked")
	}
	if err := record.Sync(); err != nil {
		return errors.New("could not sync rebuild completion; rebuild remains blocked")
	}
	if err := record.Close(); err != nil {
		return errors.New("could not close rebuild completion; rebuild remains blocked")
	}
	n, err := output.Write(result)
	if err != nil || n != len(result) {
		return errors.New("completed rebuild result delivery failed; rebuild remains blocked")
	}
	return nil
}
