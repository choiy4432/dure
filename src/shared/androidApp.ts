// 안드로이드 앱(TWA 껍데기) — 이름·서명 열쇠 지문. 지문은 공개 값이다(열쇠 자체는 레포 밖). 열쇠를 바꾸면 지문도 같이 바꾼다.

export const ANDROID_PACKAGE = 'io.github.choiy4432.dure'
export const ANDROID_TEST_PACKAGE = 'io.github.choiy4432.dure.test'

/** 진짜 앱의 서명 열쇠 SHA-256 지문 */
export const ANDROID_CERT_SHA256 = '6C:BA:40:DF:E5:09:EA:EC:50:69:2E:D4:32:EA:72:DB:42:4E:22:34:69:59:C2:BC:A4:3E:DD:22:BA:FE:E3:42'
/** 시험 앱의 서명 열쇠 SHA-256 지문 — 시험 빌드에서만 낸다 */
export const ANDROID_TEST_CERT_SHA256 = '04:62:73:66:1C:BB:59:23:1C:50:B6:2C:EC:41:4F:2D:41:C1:00:5D:01:41:20:79:D3:0D:C3:A5:01:99:A0:80'

/** 구운 APK 옆 dure.apk.json 의 꼴 */
export type AndroidApk = { versionCode: number; versionName: string; packageName: string }
