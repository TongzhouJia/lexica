package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

// WordPair 用来存储中英文对照
type WordPair struct {
	English string
	Chinese string
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	var words []WordPair

	fmt.Println("请直接粘贴单词表 (英文 中文)，粘贴完成后按一次【回车】(输入空行) 开始听写：")

	// 1. 读取粘贴的单词表
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		// 遇到空行，说明粘贴结束，跳出读取循环
		if line == "" {
			break
		}

		// 按空格或 Tab 分割，strings.Fields 会自动处理多个连续空格的情况
		parts := strings.Fields(line)
		if len(parts) < 2 {
			fmt.Printf("⚠️ 格式跳过: '%s' (确保格式为: 英文 中文)\n", line)
			continue
		}

		// 第一部分是英文，后面所有的部分拼起来是中文（防止中文释义里自带空格）
		eng := parts[0]
		chn := strings.Join(parts[1:], " ")
		words = append(words, WordPair{English: eng, Chinese: chn})
	}

	if len(words) == 0 {
		fmt.Println("没有读取到单词，程序退出。")
		return
	}

	// 分别记录对错的单词
	var correctWords []WordPair
	var wrongWords []WordPair

	fmt.Printf("\n========== 听写开始 (共 %d 个单词，输入 ':q' 提前结束) ==========\n", len(words))

	// 2. 开始互动听写
	for _, w := range words {
		fmt.Printf("\n▶ 中文: %s\n  请输入: ", w.Chinese)

		if !scanner.Scan() {
			break
		}
		input := strings.TrimSpace(scanner.Text())

		// 提前结束的指令
		if input == ":q" {
			fmt.Println("\n⏹ 听写提前结束！")
			break
		}

		// 比较英文，EqualFold 可以忽略大小写
		if strings.EqualFold(input, w.English) {
			fmt.Println("  ✅ 对了！")
			correctWords = append(correctWords, w)
		} else {
			fmt.Printf("  ❌ 错了！正确答案是: %s\n", w.English)
			wrongWords = append(wrongWords, w)
		}
	}

	// 3. 统计结果输出
	fmt.Println("\n========== 统计结果 ==========")
	totalTested := len(correctWords) + len(wrongWords)
	fmt.Printf("总计测试: %d 个单词\n", totalTested)
	fmt.Printf("✅ 答对: %d 个\n", len(correctWords))
	fmt.Printf("❌ 答错: %d 个\n", len(wrongWords))

	if len(correctWords) > 0 {
		fmt.Println("\n【答对的单词】:")
		for _, w := range correctWords {
			fmt.Printf(" - %s %s\n", w.English, w.Chinese)
		}
	}

	if len(wrongWords) > 0 {
		fmt.Println("\n【需要复习的错词】:")
		for _, w := range wrongWords {
			fmt.Printf(" - %s %s\n", w.English, w.Chinese)
		}
	}
}
