package io.github.choiy4432.dure;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** androidx 가 채널을 만드는 id 와 같아야 우리가 먼저 만든 채널(HIGH)을 쓴다 */
public class ChannelIdsTest {
    @Test
    public void lowercasesAndReplacesSpaces() {
        assertEquals("general_channel_id", ChannelIds.fromName("General"));
        assertEquals("my_cool_channel_channel_id", ChannelIds.fromName("My Cool Channel"));
    }

    @Test
    public void koreanNameKeepsLettersAndUnderscoresSpaces() {
        assertEquals("두레_알림_channel_id", ChannelIds.fromName("두레 알림"));
    }
}
