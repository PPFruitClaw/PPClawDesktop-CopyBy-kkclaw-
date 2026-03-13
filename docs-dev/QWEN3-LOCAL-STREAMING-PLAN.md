# Qwen3-TTS 本地接入与准实时播报实施方案

## 目标
- 在不修改现有 OpenClaw 配置的前提下，为桌宠新增本地 `Qwen3-TTS` 引擎。
- 启动时自动冷启动（预热），缩短首次可听见语音的等待时间。
- 采用分段合成+分段播放实现“准实时”体感。
- 保留现有引擎回退机制（`qwen3 -> edge`）。

## 范围
- 新增：`voice/qwen3-local-server.py`（本地常驻服务）
- 修改：`smart-voice.js`（新增 qwen3 引擎分支、预热、分段播报、进程管理）
- 修改：`main.js`（诊断信息适配 qwen3 引擎状态展示）

## 设计要点
1. 常驻服务
- 通过 Python 内置 `ThreadingHTTPServer` 启动服务，启动后一次性加载模型。
- 提供接口：
  - `GET /health`：健康检查
  - `POST /prewarm`：预热一次短文本
  - `POST /synthesize`：输入文本输出 wav 文件

2. 启动与预热
- `smart-voice` 初始化时读取配置，若引擎为 `qwen3` 或 `qwen3Local.enabled=true`，自动启动服务。
- 服务 ready 后执行一次预热，降低首句延迟。

3. 准实时策略
- 按标点与长度切片（首片更短）形成 chunk。
- 逐片请求 `/synthesize`，逐片调用播放器播放。
- 优先降低“首包可听见时间”，总时长仍受模型速度影响。

4. 配置（仅新增，不覆盖旧配置）
```json
{
  "ttsEngine": "qwen3",
  "qwen3Local": {
    "enabled": true,
    "rootDir": "/Users/ppg/.gemini/antigravity/scratch/VoiceClone_Qwen3-TTS/Qwen3-TTS",
    "pythonPath": "<rootDir>/.venv_qwen3/bin/python",
    "modelDir": "<rootDir>/Qwen3-TTS-12Hz-1.7B-Base",
    "refAudio": "<rootDir>/examples/tokenizer_demo_1.wav",
    "refText": "This is a reference text for cloning.",
    "device": "mps",
    "dtype": "float32",
    "port": 18789,
    "prewarmOnStart": true,
    "streaming": true,
    "firstChunkChars": 12,
    "chunkChars": 24
  }
}
```

## 降级与安全
- 任意 qwen3 合成失败时自动回退 `edge-tts`，并发送降级通知。
- Python 进程通过参数数组启动，不使用 shell 拼接命令。
- 退出桌宠时仅结束本进程拉起的服务，不误杀外部独立服务。

## 验证标准
- 桌宠启动后日志出现 `Qwen3 服务就绪` 与 `预热完成`。
- 发送消息时可触发 qwen3 分段播报。
- qwen3 出错时自动回退 edge，播报不中断。
- 应用退出后无孤儿子进程。
