package main

import (
	"flag"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

func main() {
	memoryMiB := flag.Int("memory-mib", 256, "MiB of resident memory to retain")
	cpuWorkers := flag.Int("cpu-workers", 4, "number of CPU pressure workers")
	duration := flag.Duration("duration", 30*time.Second, "pressure duration")
	flag.Parse()

	if *memoryMiB < 1 || *cpuWorkers < 1 || *duration <= 0 {
		panic("memory-mib, cpu-workers and duration must be positive")
	}

	buffer := make([]byte, *memoryMiB*1024*1024)
	for offset := 0; offset < len(buffer); offset += 4096 {
		buffer[offset] = byte(offset)
	}

	var stop atomic.Bool
	var counter atomic.Uint64
	var workers sync.WaitGroup
	workers.Add(*cpuWorkers)
	for i := 0; i < *cpuWorkers; i++ {
		go func() {
			defer workers.Done()
			for !stop.Load() {
				counter.Add(1)
			}
		}()
	}

	fmt.Printf("READY memory_mib=%d cpu_workers=%d duration=%s\n", *memoryMiB, *cpuWorkers, duration.String())
	time.Sleep(*duration)
	stop.Store(true)
	workers.Wait()
	runtime.KeepAlive(buffer)
	fmt.Printf("DONE iterations=%d\n", counter.Load())
}
