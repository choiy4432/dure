; 두레 설치·제거 프로그램에 끼우는 것 — electron-builder.yml 의 nsis.include (test/builderConfig.test.ts 가 지킨다)
;
; 제거 때 휴대폰 연결 정리: 설치 폴더의 두레를 --uninstall-cleanup 으로 띄워(창 없음) 두레가 연 tailscale serve 길과
; 이 빌드의 'Windows 를 켜면 두레도 켜기'(로그인 항목)만 끄고 기다린다(src/main/uninstallCleanup.ts — 길 끄기는 5초 상한, 전체는 15초 상한).
; 업데이트(새 판이 옛 판을 지울 때)엔 부르지 않는다 — 휴대폰 연결과 자동 켜기를 그대로 이어 간다.
; 끝 코드는 보지 않는다(정리가 실패해도 제거는 계속). 아무것도 지우지 않는다 — 앱 데이터(%APPDATA%\Dure)는 그대로.
; 정리한 두레가 나가도 Electron 도우미 프로세스는 조금 늦게 끝난다 — 1초 쉬고 electron-builder 의 '앱이 켜져 있나' 확인을 한 번 더 부른다
; (원클릭 제거는 이미 조용한 모드라 묻지 않고 남은 두레 프로세스를 끈다). 그 뒤에 electron-builder 가 RMDir /r $INSTDIR 로 파일을 지운다
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --uninstall-cleanup' $0
    ClearErrors
    Sleep 1000
    Call un.checkAppRunning
  ${endIf}
!macroend
