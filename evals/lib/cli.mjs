export function parseCliOptions(argv, specification, initial = {}) {
  const options = structuredClone(initial);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const rule = specification[argument];
    if (!rule) throw new Error(`未知参数：${argument}`);
    if (rule.type === "flag") {
      options[rule.key] = rule.value ?? true;
      continue;
    }
    const raw = argv[index + 1];
    if (raw === undefined || raw.startsWith("--")) throw new Error(`参数 ${argument} 缺少值。`);
    index += 1;
    let value = raw;
    if (rule.type === "integer") {
      value = Number.parseInt(raw, 10);
      if (!Number.isInteger(value) || String(value) !== raw.trim()) throw new Error(`参数 ${argument} 必须是整数。`);
    }
    if (rule.append) {
      if (!Array.isArray(options[rule.key])) options[rule.key] = [];
      options[rule.key].push(value);
    } else {
      options[rule.key] = value;
    }
  }
  return options;
}

export function installCliErrorHandler(prefix) {
  const report = error => {
    process.stderr.write(`${prefix}：${error?.stack || error?.message || String(error)}\n`);
    process.exit(2);
  };
  process.once("uncaughtException", report);
  process.once("unhandledRejection", report);
}
