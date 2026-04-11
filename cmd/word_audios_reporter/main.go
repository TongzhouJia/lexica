package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

func main() {
	// 获取当前工作目录
	workDir, err := os.Getwd()
	if err != nil {
		fmt.Printf("无法获取当前工作目录: %v\n", err)
		return
	}

	// 1. 设置输入和输出文件夹路径 (遵循独立工具的原则)
	// 这个工具拥有自己完全独立的输入和输出目录
	toolDataDir := filepath.Join(workDir, "data", "word_audios_reporter")
	inputDir := filepath.Join(toolDataDir, "word_audios") // 修改为与你的真实目录结构一致
	outputDir := filepath.Join(toolDataDir, "output_audios")

	// 检查输入文件夹是否存在
	if _, err := os.Stat(inputDir); os.IsNotExist(err) {
		// 自动为用户创建这个专属的输入文件夹，体验更好
		_ = os.MkdirAll(inputDir, os.ModePerm)
		fmt.Printf("❌ 错误: 找不到输入文件夹！\n")
		fmt.Printf("我已经为你建好了专属的输入目录，请把需要重复的 MP3 文件放进去:\n👉 %s\n", inputDir)
		return
	}

	// 2. 设置并发数量
	maxWorkers := 10
	sem := make(chan struct{}, maxWorkers)
	var wg sync.WaitGroup

	fmt.Println("🚀 开始扫描并处理音频文件...")

	// 3. 遍历原目录
	err = filepath.WalkDir(inputDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// 只处理 .mp3 结尾的文件
		if !d.IsDir() && strings.HasSuffix(strings.ToLower(d.Name()), ".mp3") {
			// 获取相对路径
			relPath, err := filepath.Rel(inputDir, path)
			if err != nil {
				return err
			}

			// 拼接出输出文件的完整路径
			outPath := filepath.Join(outputDir, relPath)
			outDir := filepath.Dir(outPath)

			// 确保目标目录存在
			if err := os.MkdirAll(outDir, os.ModePerm); err != nil {
				return err
			}

			// 增加一个 WaitGroup 计数
			wg.Add(1)
			// 往 channel 发送数据，占用一个 worker 位置
			sem <- struct{}{}

			// 开启 Goroutine 并发执行 FFmpeg
			go func(in, out string) {
				defer wg.Done()
				defer func() { <-sem }() // 执行完毕后释放 worker 位置

				// 组装 FFmpeg 命令：
				// [0:a] 代表第0个输入流的音频，写5次代表读取5遍
				// concat=n=5:v=0:a=1 代表把这5个音频流无缝拼接
				cmd := exec.Command("ffmpeg", "-y", "-i", in,
					"-filter_complex", "[0:a][0:a][0:a][0:a][0:a]concat=n=5:v=0:a=1[out]",
					"-map", "[out]", out)

				// 运行命令并捕获可能的错误输出
				output, err := cmd.CombinedOutput()
				if err != nil {
					fmt.Printf("❌ 失败: %s\n   错误原因: %s\n", filepath.Base(in), string(output))
				} else {
					fmt.Printf("✅ 成功: %s\n", relPath)
				}
			}(path, outPath)
		}
		return nil
	})

	if err != nil {
		fmt.Printf("⚠️ 遍历文件夹时发生错误: %v\n", err)
	}

	// 4. 等待所有后台任务全部完成
	wg.Wait()
	fmt.Printf("🎉 所有 MP3 文件重复处理完毕！请前往 %s 文件夹查看。\n", outputDir)
}
