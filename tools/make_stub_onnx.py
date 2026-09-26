"""Build a tiny stand-in ONNX model with exactly SHARP's I/O signature (see export_sharp_onnx.py).

It is NOT SHARP: it lifts each 2x2 pixel block to a Gaussian with a luminance-derived depth.
Its purpose is to test the browser inference path (onnxruntime-web, external weights,
NDC -> metric unprojection) without the 2.8 GB checkpoint.

    python tools/make_stub_onnx.py -o public/models/stub/sharp_stub.onnx
"""

import argparse
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

S, R = 1536, 768
N = R * R


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--output", type=Path, default=Path("public/models/stub/sharp_stub.onnx"))
    args = ap.parse_args()

    v = (np.arange(R, dtype=np.float32) + 0.5) / R * 2 - 1  # NDC pixel centres
    gu, gv = np.meshgrid(v, v)
    grid = np.stack([gu.ravel(), gv.ravel()], -1)[None].astype(np.float32)  # [1,N,2]

    inits = [
        numpy_helper.from_array(grid, "grid"),
        numpy_helper.from_array(np.array([1, 3, N], np.int64), "shape_c"),
        numpy_helper.from_array(np.array([1, N, 1], np.int64), "shape_z"),
        numpy_helper.from_array(np.array([3.0], np.float32), "three"),
        numpy_helper.from_array(np.array([1.2], np.float32), "depth_gain"),
        numpy_helper.from_array(np.array([[[0.0016, 0.0016, 0.0006]]], np.float32), "scale_k"),
        numpy_helper.from_array(np.array([[[1, 0, 0, 0]]], np.float32), "quat_c"),
        numpy_helper.from_array(np.array([1, N, 4], np.int64), "shape_q"),
        numpy_helper.from_array(np.array([0.97], np.float32), "opac_c"),
        numpy_helper.from_array(np.array([1, N], np.int64), "shape_o"),
    ]
    nodes = [
        helper.make_node("AveragePool", ["image"], ["pooled"], kernel_shape=[2, 2], strides=[2, 2]),
        helper.make_node("Reshape", ["pooled", "shape_c"], ["c_cn"]),
        helper.make_node("Transpose", ["c_cn"], ["c_srgb"], perm=[0, 2, 1]),
        helper.make_node("Mul", ["c_srgb", "c_srgb"], ["colors"]),  # ~linear RGB (gamma 2), like SHARP
        helper.make_node("ReduceMean", ["pooled"], ["lum"], axes=[1], keepdims=1),
        helper.make_node("Reshape", ["lum", "shape_z"], ["lum_n"]),
        helper.make_node("Mul", ["lum_n", "depth_gain"], ["lum_g"]),
        helper.make_node("Sub", ["three", "lum_g"], ["z"]),
        helper.make_node("Mul", ["grid", "z"], ["xy"]),
        helper.make_node("Concat", ["xy", "z"], ["mean_vectors"], axis=2),
        helper.make_node("Mul", ["z", "scale_k"], ["singular_values"]),
        helper.make_node("Expand", ["quat_c", "shape_q"], ["quaternions"]),
        helper.make_node("Expand", ["opac_c", "shape_o"], ["opacities"]),
    ]
    f32 = TensorProto.FLOAT
    graph = helper.make_graph(
        nodes,
        "sharp_stub",
        [helper.make_tensor_value_info("image", f32, [1, 3, S, S]),
         helper.make_tensor_value_info("disparity_factor", f32, [1])],
        [helper.make_tensor_value_info("mean_vectors", f32, [1, N, 3]),
         helper.make_tensor_value_info("singular_values", f32, [1, N, 3]),
         helper.make_tensor_value_info("quaternions", f32, [1, N, 4]),
         helper.make_tensor_value_info("colors", f32, [1, N, 3]),
         helper.make_tensor_value_info("opacities", f32, [1, N])],
        inits,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    onnx.save_model(model, str(args.output), save_as_external_data=True, all_tensors_to_one_file=True,
                    location=args.output.name + ".data", size_threshold=1024)
    print("wrote", args.output)


if __name__ == "__main__":
    main()
