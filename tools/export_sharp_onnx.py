"""Export Apple's SHARP Gaussian predictor to ONNX for in-browser inference (onnxruntime-web / WebGPU).

Usage (inside an environment with https://github.com/apple/ml-sharp installed, plus `pip install onnx`):

    python tools/export_sharp_onnx.py -c sharp_2572gikvuh.pt -o public/models/sharp.onnx --int8

Outputs
    sharp.onnx           graph (~4 MB)
    sharp.onnx.data      fp16 weights (~1.3 GB), referenced by the graph as external data
    sharp.int8.bin       (--int8) the same weights stored as int8 + per-channel scales (~0.7 GB).
                         The app downloads this instead and expands it back to sharp.onnx.data
                         in the browser, halving the download. See src/inference/weightPack.ts.

The graph is the *network only*: it maps a 1536x1536 RGB image in [0, 1] and the disparity factor
(f_px / image_width) to Gaussians in SHARP's NDC space. The app applies the NDC -> metric
unprojection itself (a per-axis scale: x *= W / 2f, y *= H / 2f), which avoids the SVD in
`sharp.utils.gaussians.unproject_gaussians` that ONNX cannot express.

Inputs:  image float32 [1, 3, 1536, 1536], disparity_factor float32 [1]
Outputs (N = 2 * 768 * 768): mean_vectors [1,N,3], singular_values [1,N,3],
    quaternions [1,N,4] (w,x,y,z), colors [1,N,3] (linear RGB), opacities [1,N]

The network is traced directly in half precision (fp32 I/O). SHARP is numerically well behaved in
fp16 (median depth error ~0.1% vs fp32), and tracing in fp16 records every dtype promotion, which
post-hoc fp32->fp16 graph converters get wrong on this model.
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np
import torch
from torch import nn

from sharp.models import PredictorParams, create_predictor

DEFAULT_MODEL_URL = "https://ml-site.cdn-apple.com/models/sharp/sharp_2572gikvuh.pt"
INTERNAL = 1536
OUTPUTS = ["mean_vectors", "singular_values", "quaternions", "colors", "opacities"]


class ExportWrapper(nn.Module):
    def __init__(self, predictor: nn.Module, dtype: torch.dtype):
        super().__init__()
        self.predictor = predictor
        self.dtype = dtype

    def forward(self, image: torch.Tensor, disparity_factor: torch.Tensor):
        g = self.predictor(image.to(self.dtype), disparity_factor.to(self.dtype))
        return tuple(getattr(g, k).float() for k in OUTPUTS)


def trace(args: argparse.Namespace) -> None:
    if args.checkpoint is None:
        state_dict = torch.hub.load_state_dict_from_url(DEFAULT_MODEL_URL, progress=True)
    else:
        state_dict = torch.load(args.checkpoint, weights_only=True, map_location="cpu")

    dtype = torch.float32 if args.fp32 else torch.float16
    predictor = create_predictor(PredictorParams())
    predictor.load_state_dict(state_dict)
    del state_dict
    model = ExportWrapper(predictor.eval().to(args.device, dtype), dtype).eval()

    image = torch.rand(1, 3, INTERNAL, INTERNAL, device=args.device)
    disparity_factor = torch.tensor([1.0], device=args.device)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with torch.no_grad():
        torch.onnx.export(
            model,
            (image, disparity_factor),
            str(args.output),
            input_names=["image", "disparity_factor"],
            output_names=OUTPUTS,
            opset_version=args.opset,
            do_constant_folding=True,
            dynamo=False,
        )


def consolidate(output: Path) -> None:
    """Re-save with all weights in one external file (`<name>.onnx.data`) and remove the per-tensor files."""
    import onnx

    model = onnx.load(str(output), load_external_data=True)
    stale = {
        entry.value
        for init in model.graph.initializer
        for entry in init.external_data
        if entry.key == "location"
    }
    data_name = output.name + ".data"
    onnx.save_model(
        model,
        str(output),
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=data_name,
        size_threshold=1024,
    )
    for name in stale - {data_name}:
        (output.parent / name).unlink(missing_ok=True)


def write_int8_pack(output: Path, min_elements: int = 16384) -> Path:
    """Store the external weights as int8 + per-output-channel scales.

    Pack layout (little endian):
        b"MVSQ8\\0\\0\\0" | u32 header_len | header JSON | zero pad to 16 | payload
    header: {"dataFile", "dataLength", "chunks": [...]} where each chunk covers a byte range
    [off, off + len) of the fp16 data file and is either
        {"kind": "raw", "off", "len", "src"}                     bytes copied verbatim
        {"kind": "q8", "off", "len", "src", "rows", "cols", "axis"}
            int8[rows * cols] at src, then float32 scales (rows if axis == 0 else cols);
            value = int8 * scale, written back as fp16.
    Quantisation is per output channel: axis 0 for Conv/Gemm weights ([out, ...]),
    axis 1 for MatMul right-hand sides ([in, out]).
    """
    import onnx
    from onnx import TensorProto

    model = onnx.load(str(output), load_external_data=False)
    data_path = output.parent / (output.name + ".data")
    data = np.memmap(data_path, dtype=np.uint8, mode="r")

    consumers: dict[str, tuple[str, int]] = {}
    for node in model.graph.node:
        for i, name in enumerate(node.input):
            consumers.setdefault(name, (node.op_type, i))

    regions = []
    for init in model.graph.initializer:
        ext = {e.key: e.value for e in init.external_data}
        if "offset" not in ext:
            continue
        off, length = int(ext["offset"]), int(ext["length"])
        dims = list(init.dims)
        numel = int(np.prod(dims)) if dims else 1
        op, idx = consumers.get(init.name, ("", -1))
        axis = None
        if init.data_type == TensorProto.FLOAT16 and len(dims) >= 2 and numel >= min_elements:
            if op in ("Conv", "ConvTranspose", "Gemm") and idx == 1:
                axis = 0
            elif op == "MatMul" and idx == 1 and len(dims) == 2:
                axis = 1
        regions.append((off, length, dims, axis))
    regions.sort()

    chunks, payload = [], bytearray()
    cursor = 0
    total = len(data)
    for off, length, dims, axis in regions:
        if off > cursor:  # alignment padding between tensors
            chunks.append({"kind": "raw", "off": cursor, "len": off - cursor, "src": len(payload)})
            payload += data[cursor:off].tobytes()
        raw = data[off:off + length]
        if axis is None:
            chunks.append({"kind": "raw", "off": off, "len": length, "src": len(payload)})
            payload += raw.tobytes()
        else:
            w = np.frombuffer(raw.tobytes(), dtype=np.float16).astype(np.float32).reshape(dims[0], -1)
            if axis == 0:
                scale = np.abs(w).max(axis=1, keepdims=True) / 127
            else:
                scale = np.abs(w).max(axis=0, keepdims=True) / 127
            scale = np.maximum(scale, 1e-12).astype(np.float32)
            q = np.clip(np.rint(w / scale), -127, 127).astype(np.int8)
            chunks.append({"kind": "q8", "off": off, "len": length, "src": len(payload),
                           "rows": int(w.shape[0]), "cols": int(w.shape[1]), "axis": axis})
            payload += q.tobytes()
            payload += b"\0" * ((-len(payload)) % 4)
            payload += scale.ravel().tobytes()
        cursor = off + length
    if cursor < total:
        chunks.append({"kind": "raw", "off": cursor, "len": total - cursor, "src": len(payload)})
        payload += data[cursor:total].tobytes()

    header = json.dumps({"dataFile": data_path.name, "dataLength": int(total), "chunks": chunks}).encode()
    pad = (-(8 + 4 + len(header))) % 16
    pack_path = output.parent / (output.stem + ".int8.bin")
    with open(pack_path, "wb") as f:
        f.write(b"MVSQ8\0\0\0")
        f.write(struct.pack("<I", len(header)))
        f.write(header)
        f.write(b"\0" * pad)
        f.write(payload)
    q8 = sum(c["len"] for c in chunks if c["kind"] == "q8")
    print(f"Wrote {pack_path} ({pack_path.stat().st_size / 1e6:.0f} MB, {q8 / total:.0%} of weights quantised)")
    return pack_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("-c", "--checkpoint", type=Path, default=None)
    parser.add_argument("-o", "--output", type=Path, default=Path("public/models/sharp.onnx"))
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument("--fp32", action="store_true", help="Export fp32 weights (2.8 GB; exceeds browser limits).")
    parser.add_argument("--int8", action="store_true", help="Also write the int8 download pack.")
    parser.add_argument("--pack-only", action="store_true", help="Only (re)build the int8 pack from an existing export.")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu",
                        help="Device used for tracing (fp16 tracing needs cuda).")
    args = parser.parse_args()

    if not args.pack_only:
        trace(args)
        consolidate(args.output)
        print(f"Wrote {args.output} (+ {args.output.name}.data)")
    if args.int8 or args.pack_only:
        write_int8_pack(args.output)


if __name__ == "__main__":
    main()
