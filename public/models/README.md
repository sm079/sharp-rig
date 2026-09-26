# Model weights

`tools/export_sharp_onnx.py --int8` writes SHARP here so the static site can serve it:

```
public/models/sharp.onnx        graph (~4 MB)
public/models/sharp.int8.bin    int8 weight pack the app downloads (~0.66 GB)
public/models/sharp.onnx.data   fp16 weights (~1.3 GB): optional, only used to rebuild the pack
```

They are git-ignored. `stub/` can hold the tiny test model from `tools/make_stub_onnx.py`.
