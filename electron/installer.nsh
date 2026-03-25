; 제거 시: 모든 잔여 폴더 완전 삭제
!macro customUnInstall
  RMDir /r "$LOCALAPPDATA\misulgom-youtube-analyzer-updater"
  RMDir /r "$LOCALAPPDATA\Programs\misulgom-youtube-analyzer"
  RMDir /r "$PROGRAMFILES64\misulgom-youtube-analyzer"
  RMDir /r "$PROGRAMFILES\misulgom-youtube-analyzer"
  ; 구버전 앱 잔여
  RMDir /r "$LOCALAPPDATA\youtube-topic-analyzer-updater"
  RMDir /r "$APPDATA\youtube-topic-analyzer"
  RMDir /r "$PROGRAMFILES64\YouTube Script Automation"
  RMDir /r "$PROGRAMFILES\YouTube Script Automation"
!macroend
