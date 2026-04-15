package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	fmt.Println("=== ADB 文件传输工具 ===")

	// 1. 检查本地环境是否有 adb
	if _, err := exec.LookPath("adb"); err != nil {
		fmt.Println("错误: 未找到 adb 命令，请确保已安装并配置了环境变量。")
		os.Exit(1)
	}

	var path string

	// 2. 获取路径（参数或交互式）
	if len(os.Args) > 1 {
		path = os.Args[1]
	} else {
		fmt.Print("请输入要传输的文件或文件夹路径: ")
		reader := bufio.NewReader(os.Stdin)
		input, err := reader.ReadString('\n')
		if err != nil {
			fmt.Println("读取输入失败:", err)
			return
		}
		path = input
	}

	path = strings.TrimSpace(path)
	path = strings.Trim(path, `"'`)

	if path == "" {
		fmt.Println("路径不能为空，已退出。")
		return
	}

	// 3. 验证本地文件是否存在
	if _, err := os.Stat(path); os.IsNotExist(err) {
		fmt.Printf("错误: 本地文件或目录 '%s' 不存在。\n", path)
		return
	}

	target := "/sdcard/download/"
	fmt.Printf("正在将 '%s' 传输到 '%s'...\n", path, target)

	// 4. 执行 adb push 并捕获错误
	cmd := exec.Command("adb", "push", path, target)
	cmd.Stdout = os.Stdout
	var stderr bytes.Buffer
	cmd.Stderr = io.MultiWriter(os.Stderr, &stderr)

	if err := cmd.Run(); err != nil {
		errorMsg := strings.TrimSpace(stderr.String())
		if errorMsg == "" {
			errorMsg = err.Error()
		}
		fmt.Println("传输失败:", err)

		// 手机弹窗提示失败
		notifyTitle := "❌ 文件传输失败"
		notifyText := fmt.Sprintf("错误原因: %s", errorMsg)
		exec.Command("adb", "shell", "cmd", "notification", "post", "-S", "bigtext", "-t", notifyTitle, "ADB_PUSHER", notifyText).Run()
	} else {
		fmt.Println("传输完成!")

		// 手机弹窗提示成功
		fileName := filepath.Base(path)
		notifyTitle := "✅ 文件传输成功"
		notifyText := fmt.Sprintf("文件 '%s' 已成功传输至 %s", fileName, target)
		exec.Command("adb", "shell", "cmd", "notification", "post", "-S", "bigtext", "-t", notifyTitle, "ADB_PUSHER", notifyText).Run()
	}
}
