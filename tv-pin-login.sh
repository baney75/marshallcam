#!/bin/bash
# macOS bash 3.2

set +x

SOURCE_FILE="/Users/__USER__/MarshallOS/src/MarshallCamServer.ts"
ENV_FILE="/Users/__USER__/MarshallOS/.env"
OUT_FILE="/tmp/tv-pin.out"
BUNDLE_ID="com.apple.Safari.WebApp.__WEBAPP_ID__"

line=""
while IFS= read -r current_line || [ -n "$current_line" ]; do
    case "$current_line" in
        "const PASSWORD = "*)
            line=$current_line
            break
            ;;
    esac
done < "$SOURCE_FILE" 2>/dev/null

pin=""
literal=""
quote=""
in_quote=0
closed_quote=0
i=0

# Take only the first quoted string literal on the matching source line.
while [ "$i" -lt "${#line}" ]; do
    ch=${line:i:1}

    if [ "$in_quote" -eq 0 ]; then
        case "$ch" in
            \"|\'|\`)
                quote=$ch
                in_quote=1
                literal=""
                ;;
        esac
    else
        if [ "$ch" = "$quote" ]; then
            closed_quote=1
            break
        fi
        literal="${literal}${ch}"
    fi

    i=$((i + 1))
done

if [ "$closed_quote" -eq 1 ]; then
    case "$literal" in
        [0-9][0-9][0-9][0-9])
            pin=$literal
            ;;
    esac
fi

# If no valid literal was found, resolve a direct process.env.NAME reference.
if [ -z "$pin" ] && [[ "$line" =~ process\.env\.([A-Za-z_][A-Za-z0-9_]*) ]]; then
    env_name=${BASH_REMATCH[1]}

    if [ -r "$ENV_FILE" ]; then
        while IFS= read -r env_line || [ -n "$env_line" ]; do
            env_line=${env_line%$'\r'}

            case "$env_line" in
                "$env_name"=*)
                    env_value=${env_line#*=}

                    case "$env_value" in
                        \"*\"|\'*\')
                            env_value=${env_value#?}
                            env_value=${env_value%?}
                            ;;
                    esac

                    case "$env_value" in
                        [0-9][0-9][0-9][0-9])
                            pin=$env_value
                            break
                            ;;
                    esac
                    ;;
            esac
        done < "$ENV_FILE"
    fi
fi

if [ -z "$pin" ]; then
    printf '%s\n' "no pin" > "$OUT_FILE"
    exit 1
fi

result=$(
    PIN="$pin" /usr/bin/osascript \
        -e 'on buttonExists(uiContents, wantedTitle)' \
        -e '    tell application "System Events"' \
        -e '        repeat with candidate in uiContents' \
        -e '            try' \
        -e '                if class of candidate is button then' \
        -e '                    if title of candidate is wantedTitle then return true' \
        -e '                end if' \
        -e '            end try' \
        -e '        end repeat' \
        -e '    end tell' \
        -e '    return false' \
        -e 'end buttonExists' \
        -e 'on clickButton(uiContents, wantedTitle)' \
        -e '    tell application "System Events"' \
        -e '        repeat with candidate in uiContents' \
        -e '            try' \
        -e '                if class of candidate is button then' \
        -e '                    if title of candidate is wantedTitle then' \
        -e '                        click candidate' \
        -e '                        return true' \
        -e '                    end if' \
        -e '                end if' \
        -e '            end try' \
        -e '        end repeat' \
        -e '    end tell' \
        -e '    return false' \
        -e 'end clickButton' \
        -e 'set pinText to system attribute "PIN"' \
        -e 'tell application "System Events"' \
        -e "    set targetProcess to first process whose bundle identifier is \"$BUNDLE_ID\"" \
        -e '    set targetWindow to window 1 of targetProcess' \
        -e '    set uiContents to entire contents of targetWindow' \
        -e 'end tell' \
        -e 'repeat with requiredTitle in {"1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "Delete"}' \
        -e '    if not (my buttonExists(uiContents, requiredTitle as text)) then return "no pinpad"' \
        -e 'end repeat' \
        -e 'set pinLength to length of pinText' \
        -e 'repeat with pinIndex from 1 to pinLength' \
        -e '    set wantedTitle to character pinIndex of pinText' \
        -e '    if not (my clickButton(uiContents, wantedTitle)) then return "no pinpad"' \
        -e '    if pinIndex is less than pinLength then delay 0.4' \
        -e 'end repeat' \
        -e 'return "entered"' \
        2>&1
)

pin=""
printf '%s\n' "$result" > "$OUT_FILE"
exit 0
