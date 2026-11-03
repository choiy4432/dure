// 테스트용 가짜 설치 스크립트 — 줄 몇 개를 (조금씩 늦춰) 찍고 FAKE_INSTALL_CODE 로 끝난다. 불린 횟수는 FAKE_INSTALL_LOG 에 한 줄씩 남긴다.
import fs from 'node:fs'

if (process.env.FAKE_INSTALL_LOG) fs.appendFileSync(process.env.FAKE_INSTALL_LOG, 'run\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const line of ['가짜 설치: 내려받는 중', '가짜 설치: 푸는 중', '가짜 설치: 마무리']) {
  console.log(line)
  await sleep(150)
}
process.exit(Number(process.env.FAKE_INSTALL_CODE ?? 0))
