#!/bin/bash
/usr/bin/osascript -e "tell application \"System Events\"
set p to first process whose bundle identifier is \"com.apple.Safari.WebApp.__WEBAPP_ID__\"
set w to first window of p whose subrole is \"AXDialog\"
if (value of static text 1 of w) contains \"camera and microphone\" then
click button \"OK\" of w
return \"clicked\"
end if
return \"no match\"
end tell" > /tmp/ui-ok.out 2>&1
