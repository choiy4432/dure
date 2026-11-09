package io.github.choiy4432.dure;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** 받은 주소를 쓸지 · 열 주소(?app=) · origin — 기기 없이 */
public class LaunchUrlsTest {
    @Test
    public void acceptedHttpsTsNet() {
        String url = "https://pc.tail0000.ts.net:47615/mobile.html#agent=a1";
        assertEquals(url, LaunchUrls.acceptedUrl(url));
    }

    @Test
    public void rejectsNonTsNet() {
        assertNull(LaunchUrls.acceptedUrl("http://pc.tail0000.ts.net/"));
        assertNull(LaunchUrls.acceptedUrl("https://evil.example/"));
        assertNull(LaunchUrls.acceptedUrl("https://ts.net.evil.example/"));
        assertNull(LaunchUrls.acceptedUrl("https://pc.tail0000.ts.net.evil.example/"));
        assertNull(LaunchUrls.acceptedUrl("https:///"));
        assertNull(LaunchUrls.acceptedUrl("https://.ts.net/"));
        assertNull(LaunchUrls.acceptedUrl(""));
        assertNull(LaunchUrls.acceptedUrl(null));
    }

    @Test
    public void launchUrlKeepsPortHashAndAddsApp() {
        assertEquals("https://pc.tail0000.ts.net:47615/mobile.html?app=3#agent=a1",
                LaunchUrls.launchUrl("https://pc.tail0000.ts.net:47615/mobile.html#agent=a1", 3));
        assertEquals("https://pc.tail0000.ts.net:47615/mobile.html?x=1&app=3#pair=k",
                LaunchUrls.launchUrl("https://pc.tail0000.ts.net:47615/mobile.html?x=1#pair=k", 3));
        assertEquals("https://pc.tail0000.ts.net/mobile.html?app=3",
                LaunchUrls.launchUrl("https://pc.tail0000.ts.net/mobile.html", 3));
        // 있던 app= 은 새 판으로 바꾼다(웹이 옛 판을 읽지 않게)
        assertEquals("https://pc.tail0000.ts.net/mobile.html?x=1&app=3",
                LaunchUrls.launchUrl("https://pc.tail0000.ts.net/mobile.html?app=1&x=1", 3));
    }

    @Test
    public void originOf() {
        assertEquals("https://pc.tail0000.ts.net:47615",
                LaunchUrls.originOf("https://pc.tail0000.ts.net:47615/mobile.html#agent=a1"));
        assertEquals("https://pc.tail0000.ts.net", LaunchUrls.originOf("https://pc.tail0000.ts.net/x?y=1"));
        assertNull(LaunchUrls.originOf("not a url"));
        assertNull(LaunchUrls.originOf(null));
    }
}
