---
description: 根据最近的提交整理站会发言
argument-hint: "[天数，默认 1]"
---
看一下最近 ${1:-1} 天我在这个仓库里的提交（git log --author="$(git config user.name)" --since="${1:-1} days ago" --stat），
整理成站会发言，三部分：昨天做了什么、今天打算做什么（根据未完成的改动和 TODO 推测，标明是推测）、有没有阻碍。
每部分不超过三条，用中文，口语化。不要改任何文件。
