#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_tiers.py —— 生成"优先级"学习源

把 新标日 5805 词按面试优先级切成五档，外加两组书里没有的专业词，
写成 app 的 4 列 CSV 格式：data/japanese/tiers/<tier>/<tier>_partN.csv

档位来源：分级词表/3_日语词表/00_全部_已分级.csv 的 优先级 列（S/A/B/C/D）
专业词来源：分级词表/2_专业词汇/01_DCO专业词.csv、02_JD点名ITIL词.csv

新标日的词带本地 mp3；专业词没有音频，播放时走 ja-JP TTS。

用法: python3 scripts/build_tiers.py [分级词表目录]
"""
import csv, os, sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ROOT = os.path.join(REPO, 'data', 'japanese', 'tiers')
DEFAULT_SRC = '/Users/jiatongzhou/Downloads/新标日单词/分级词表'
PART_SIZE = 100          # 每个 partN 的词数，和分卷的手感保持一致
HEADER = ['日文(汉字)', '假名读音', '中文释义', '音频文件']

# 源文件在分级词表里的相对路径（目录已按用途重排，见那边的 README.md）
SRC_ALL = os.path.join('3_日语词表', '00_全部_已分级.csv')
SRC_DCO = os.path.join('2_专业词汇', '01_DCO专业词.csv')
SRC_JD = os.path.join('2_专业词汇', '02_JD点名ITIL词.csv')

# (目录名, 显示名, 取数方式)
TIERS = [
    ('1_必会',       '必会',         ('grade', 'S')),
    ('2_普通掌握',   '普通掌握',     ('grade', 'A')),
    ('3_掌握最好',   '掌握最好',     ('grade', 'B')),
    ('4_会不会都行', '会不会都行',   ('grade', 'C')),
    ('5_别看',       '浪费时间别看', ('grade', 'D')),
    ('6_DCO专业词',  'DCO专业词',    ('file', SRC_DCO)),
    ('7_JD点名词',   'JD点名词',     ('file', SRC_JD)),
]


def read_csv(path):
    with open(path, encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def rows_from_grade(src_dir, grade):
    """从总表按优先级取，跳过重复条目（同词在两册都出现时只留一次）"""
    out = []
    for r in read_csv(os.path.join(src_dir, SRC_ALL)):
        if r['优先级'] != grade or r.get('重复') == '重':
            continue
        out.append([r['日文(汉字)'], r['假名读音'], r['中文释义'], r['音频文件']])
    return out


def rows_from_file(src_dir, fname):
    """专业词表：列名不同，且没有音频（留空 → 前端走 ja-JP TTS）"""
    out = []
    for r in read_csv(os.path.join(src_dir, fname)):
        jp = (r.get('日文') or r.get('日文(汉字)') or '').strip()
        if not jp:
            continue
        kana = (r.get('假名读音') or '').strip()
        cn = (r.get('中文释义') or '').strip()
        out.append([jp, kana, cn, ''])   # 音频留空
    return out


def clear_dir(d):
    """清掉旧的 partN，避免上一次跑剩下的多余分卷。
    某些挂载盘不允许 unlink，删不掉就跳过——反正同名文件会被覆盖，
    只有词数变少时才可能留下尾部的残余分卷，那时会打印提醒。"""
    if not os.path.isdir(d):
        return 0
    left = 0
    for f in os.listdir(d):
        if not f.endswith('.csv'):
            continue
        try:
            os.remove(os.path.join(d, f))
        except OSError:
            left += 1
    return left


def write_tier(tier_id, rows):
    d = os.path.join(OUT_ROOT, tier_id)
    os.makedirs(d, exist_ok=True)
    stale = clear_dir(d)
    if stale:
        print(f'  ⚠️  {tier_id}: {stale} 个旧分卷删不掉（权限），已覆盖同名文件')
    n = 0
    for i in range(0, len(rows), PART_SIZE):
        n += 1
        p = os.path.join(d, f'{tier_id}_part{n}.csv')
        with open(p, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f)
            w.writerow(HEADER)
            w.writerows(rows[i:i + PART_SIZE])
    return n


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.isdir(src):
        sys.exit(f'找不到分级词表目录: {src}')

    os.makedirs(OUT_ROOT, exist_ok=True)   # 逐档清理见 write_tier/clear_dir

    total = 0
    print(f'{"档位":14s} {"词数":>6s} {"分卷":>4s}  {"音频":>6s}')
    print('-' * 40)
    for tier_id, label, (kind, arg) in TIERS:
        rows = rows_from_grade(src, arg) if kind == 'grade' else rows_from_file(src, arg)
        if not rows:
            print(f'{label:14s} 空，跳过')
            continue
        parts = write_tier(tier_id, rows)
        withaudio = sum(1 for r in rows if r[3])
        total += len(rows)
        print(f'{label:14s} {len(rows):6d} {parts:4d}  {withaudio:6d}')
    print('-' * 40)
    print(f'{"合计":14s} {total:6d}')
    print(f'\n输出目录: {OUT_ROOT}')


if __name__ == '__main__':
    main()
