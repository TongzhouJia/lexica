# My Toolbox

这个项目用于存放各种自己写的 Go 语言小工具。

## 目录结构说明

```
.
├── .env                # 配置文件，存放 API Key 等机密信息（被 Git 忽略，不提交）
├── cmd/                # 所有的工具代码存放在此，每个工具一个文件夹
│   └── tts_downloader/ # 举例：谷歌 TTS 语音合成下载工具
│       └── main.go
├── data/               # 所有工具的输入、输出数据统一存放在这里（被 Git 忽略，不提交）
│   ├── tts_downloader/ # tts_downloader 工具的专属数据文件夹
│   │   ├── word.txt    # 输入的文本文件
│   │   └── word_audios/# 输出的音频文件夹
│   └── image_resizer/  # 举例：其他工具的专属数据文件夹
└── .gitignore          # 配置 Git 忽略的文件和文件夹
```

## 如何运行工具

1. 确保当前终端的工作目录在项目的根目录。
2. 运行指定的工具：

```bash
go run cmd/tts_downloader/main.go
```
