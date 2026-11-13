// Deterministic synthetic CI / training log used by the tests.

const TEMPLATES = [
  '2026-11-12 09:12:33.101 INFO  [main] Starting training run id={id} on 8 GPUs',
  '2026-11-12 09:12:33.204 DEBUG [loader] loaded shard {id} of 128 from /data/shards/part-{id}.safetensors',
  '2026-11-12 09:12:34.002 WARN  [config] deprecated flag --fp16 used; use --precision=fp16 instead',
  '2026-11-12 09:12:35.871 ERROR [worker-{id}] RuntimeError: CUDA error: an illegal memory access was encountered',
  'Traceback (most recent call last):',
  '  File "/usr/lib/python3.10/site-packages/torch/nn/modules/module.py", line {id}, in _call_impl',
  '    return forward_call(*input, **kwargs)',
  'torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 79.15 GiB total capacity)',
  '[rank3]:[E ProcessGroupNCCL.cpp:563] Watchdog caught collective operation timeout: WorkNCCL(SeqNum={id}) ran for 600000 milliseconds before timing out.',
  'NCCL WARN Call to ibv_create_cq failed with error Cannot allocate memory',
  'kernel: NVRM: Xid (PCI:0000:3b:00): 79, pid={id}, GPU has fallen off the bus.',
  'kernel: Out of memory: Killed process {id} (python) total-vm:123456kB',
  'make[2]: *** [CMakeFiles/foo.dir/build.make:76: foo.o] Error 1',
  "/src/foo.cc:{id}:10: error: 'bar' was not declared in this scope",
  "/src/foo.cc:{id}:5: warning: unused variable 'x' [-Wunused-variable]",
  "ld: undefined reference to `vtable for Foo'",
  'collect2: error: ld returned 1 exit status',
  '==4242==ERROR: AddressSanitizer: heap-use-after-free on address 0x602000000010',
  'Warning  BackOff  pod/trainer-{id}  Back-off restarting failed container',
  'Normal   Pulled   pod/trainer-{id}  Successfully pulled image in 3.2s',
  'Error: Process completed with exit code 1.',
  'npm ERR! code ELIFECYCLE',
  'Exception in thread "main" java.lang.IllegalStateException: connection pool exhausted',
  'Caused by: java.net.SocketTimeoutException: Read timed out',
  'panic: runtime error: invalid memory address or nil pointer dereference',
  'goroutine {id} [running]:',
  "thread 'main' panicked at 'index out of bounds', src/main.rs:{id}:5",
  '2026-11-12 09:13:01.555 INFO  [eval] step={id} loss=2.3141 lr=3e-4 throughput=1234 tok/s',
  '2026-11-12 09:13:02.555 INFO  [eval] step={id} loss=nan lr=3e-4 grad_norm=inf',
  'The quick brown fox jumps over the lazy dog while the room is zoomed and the default settings apply.',
  'Pleasant peasants in Hungary met the deadline for the banana maintenance project.',
  '2026-11-12 09:13:05.000 INFO  [http] GET /api/v1/models 200 12ms',
  '2026-11-12 09:13:06.000 ERROR [http] POST /api/v1/generate 503 Service Unavailable (upstream connect error)',
  'Segmentation fault (core dumped)',
  'E1112 09:13:07.123456 {id} tensorrt_engine.cc:88] [TRT] [E] 1: [defaultAllocator.cpp::deallocate::42] Error Code 1: Cuda Runtime (invalid argument)',
  '[W] [TRT] TensorRT was linked against cuDNN 8.9.0 but loaded cuDNN 8.6.0',
  'ImportError: libcudart.so.12: cannot open shared object file: No such file or directory',
  'ERROR: Could not find a version that satisfies the requirement torch==9.9 (from versions: none)',
  'assert x.shape == y.shape, f"size mismatch {id}"',
  'AssertionError: expected tensors to be on the same device'
];

// mulberry32: small seeded PRNG so every run sees the same log
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleLines(count = 4000, seed = 42) {
  const rand = rng(seed);
  const out = [];
  for (let i = 0; i < count; i++) {
    const template = TEMPLATES[Math.floor(rand() * TEMPLATES.length)];
    out.push(template.replace('{id}', String(1 + Math.floor(rand() * 99999))));
  }
  return out;
}
