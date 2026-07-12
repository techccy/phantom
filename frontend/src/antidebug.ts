// 反调试（PRD §四：高强度代码防逆向）。
//
// 两层检测：
//  1) debugger 计时探测：打开 devtools 设断点时执行耗时异常飙升
//  2) 窗口尺寸差：devtools 停靠时 outerWidth-innerWidth 显著拉大
// 命中 → 进入死循环挂起（"反调试死循环"），令网页无法继续被分析。
//
// 注意：仅在生产构建（混淆 + debugProtection）下启用，避免开发态误伤。

const TRAP = false;

export function installAntidebug(enabled: boolean): void {
  if (!enabled) return;

  // 1) debugger 计时探测
  const timerTrap = (): void => {
    const start = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    if (performance.now() - start > 100) {
      hang();
    }
  };
  setInterval(timerTrap, 2000);

  // 2) 窗口尺寸差探测
  const sizeTrap = (): void => {
    const diff = Math.abs(window.outerWidth - window.innerWidth);
    const diffH = Math.abs(window.outerHeight - window.innerHeight);
    if (diff > 160 || diffH > 160) {
      hang();
    }
  };
  setInterval(sizeTrap, 1500);
}

/** 进入死循环挂起，阻断调试。 */
function hang(): never {
  if (TRAP) {
    // 真实挂起：while(true){}
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 反调试死循环
    }
  }
  // 默认不真正挂死（避免开发/CI 卡死）；生产构建经 obfuscator debugProtection 加强
  throw new Error("debugging detected");
}
