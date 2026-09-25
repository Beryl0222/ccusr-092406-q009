// 时间比较的小工具：所有时间在领域内都是 ISO 8601 字符串，比较时统一转毫秒。

export function ts(iso) {
  const value = Date.parse(iso);
  if (Number.isNaN(value)) throw new Error(`无法解析的时间: ${iso}`);
  return value;
}

// 两个 {start, end} 区间是否重叠（半开区间语义：首尾相接不算重叠）。
export function overlaps(a, b) {
  return ts(a.start) < ts(b.end) && ts(b.start) < ts(a.end);
}

// slot 是否完整落在 [start, end] 区间内。
export function within(slot, start, end) {
  return ts(slot.start) >= ts(start) && ts(slot.end) <= ts(end);
}
