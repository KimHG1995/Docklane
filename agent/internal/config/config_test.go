package config

import "testing"

func TestValidateLoopbackAddr(t *testing.T) {
	for _, addr := range []string{
		"127.0.0.1:9443",
		"localhost:9443",
		"[::1]:9443",
	} {
		if err := validateLoopbackAddr(addr); err != nil {
			t.Fatalf("expected %s to be allowed: %v", addr, err)
		}
	}
}

func TestValidateLoopbackAddrRejectsNonLoopback(t *testing.T) {
	for _, addr := range []string{
		":9443",
		"0.0.0.0:9443",
		"192.168.0.10:9443",
	} {
		if err := validateLoopbackAddr(addr); err == nil {
			t.Fatalf("expected %s to be rejected", addr)
		}
	}
}
