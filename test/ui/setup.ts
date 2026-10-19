// 화면 테스트 준비 — jsdom 에 없는 브라우저 기능을 빈 것으로 채운다(React Flow 가 처음 그릴 때 쓴다)
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}
