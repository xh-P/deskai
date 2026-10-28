# 本地浏览器音频依赖来源

- vad-web 0.0.31：npm 发布 gitHead `de9b3ff83fd44cd7a2b3e07e9454e6b6f0bc249d`；[原 LICENSE](https://github.com/ricky0123/vad/blob/de9b3ff83fd44cd7a2b3e07e9454e6b6f0bc249d/LICENSE)，ISC，包含 Silero 的 MIT 声明。
- ONNX Runtime Web 1.22.0：[原 LICENSE](https://github.com/microsoft/onnxruntime/blob/v1.22.0/LICENSE)，MIT。
- Silero VAD v5 权重来自上述 vad-web 包，不单独下载不明版本；[上游许可](https://github.com/snakers4/silero-vad/blob/master/LICENSE)，MIT。

构建只从 lockfile 对应的 node_modules 复制 worklet/ONNX/WASM 到本地静态资源；不运行 CDN 脚本。这里记录所用语音依赖，不代替未来完整发行包的所有第三方声明。
