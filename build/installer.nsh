; 두레 설치·제거 프로그램에 끼우는 것 — electron-builder.yml 의 nsis.include (test/builderConfig.test.ts 가 지킨다)
;
; 제거 때 휴대폰 연결 정리: 설치 폴더의 두레를 --uninstall-cleanup 으로 띄워(창 없음) 두레가 연 tailscale serve 길과
; 이 빌드의 'Windows 를 켜면 두레도 켜기'(로그인 항목)만 끄고 기다린다(src/main/uninstallCleanup.ts — 길 끄기는 5초 상한).
; 업데이트(새 판이 옛 판을 지울 때)엔 부르지 않는다 — 휴대폰 연결과 자동 켜기를 그대로 이어 간다.
; 끝 코드는 보지 않는다(정리가 실패해도 제거는 계속). 아무것도 지우지 않는다 — 앱 데이터(%APPDATA%\Dure)는 그대로.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup' $0
    ClearErrors
  ${endIf}
!macroend
