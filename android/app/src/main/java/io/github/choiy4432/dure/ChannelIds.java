package io.github.choiy4432.dure;

import java.util.Locale;

/** androidx.browser 의 TrustedWebActivityService 가 채널 이름에서 만드는 채널 id 와 똑같이(1.10.0 바이트코드로 확인) */
final class ChannelIds {
    private ChannelIds() {}

    static String fromName(String channelName) {
        return channelName.toLowerCase(Locale.ROOT).replace(' ', '_') + "_channel_id";
    }
}
