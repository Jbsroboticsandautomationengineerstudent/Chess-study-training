Place a Maia 3 ONNX export named `maia3_5m.onnx` in this directory.

The Pages workflow copies `web/` into the published site, so the model URL is:

`https://jbsroboticsandautomationengineerstudent.github.io/Chess-study-training/models/maia3_5m.onnx`

The model must use the input and output contract documented at the top of
`userscript.js`. A `.pt` or `.mlpackage` file is not an ONNX export.
The `cstr/maia3-onnx-int32` 5M model on Hugging Face has the matching
Safari-friendly input types and `logits_move` output. Check its AGPL-3.0
licensing terms before redistributing it.
