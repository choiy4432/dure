package io.github.choiy4432.dure;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** 받은 주소를 쓸지 · 열 주소(?app=) · origin · 시작 화면이 할 일(decide) — 기기 없이 */
public class LaunchUrlsTest {
    private static final String PC = "https://pc.tail0000.ts.net:47615";
    private static final String OTHER = "https://other.tail1111.ts.net:47615";

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
        assertEquals(PC, LaunchUrls.originOf("https://pc.tail0000.ts.net:47615/mobile.html#agent=a1"));
        assertEquals("https://pc.tail0000.ts.net", LaunchUrls.originOf("https://pc.tail0000.ts.net/x?y=1"));
        assertNull(LaunchUrls.originOf("not a url"));
        assertNull(LaunchUrls.originOf(null));
    }

    @Test
    public void originOfIsCanonical() {
        // 호스트 대소문자 · https 기본 포트(443)는 같은 origin 이다(브라우저와 같게)
        assertEquals(PC, LaunchUrls.originOf("https://PC.Tail0000.TS.NET:47615/mobile.html"));
        assertEquals("https://pc.tail0000.ts.net", LaunchUrls.originOf("https://pc.tail0000.ts.net:443/mobile.html"));
    }

    // ── decide: 시작 화면이 할 일 ──

    @Test
    public void firstOriginAsks() {
        // 기억한 PC 가 없어도 받은 *.ts.net 주소는 묻는다 — 묻기 전에는 아무것도 기억하지 않고 열지도 않는다
        LaunchUrls.Decision d = LaunchUrls.decide(PC + "/mobile.html?x=1#pair=k", null, 3);
        assertEquals(LaunchUrls.Decision.Kind.CONFIRM, d.kind);
        assertEquals("pc.tail0000.ts.net:47615", d.host);
        assertNull(d.url);
        assertNull(d.save);
        // [잇기] — origin 만 기억하고(쿼리·# 은 그때 한 번 연다) 받은 주소를 연다
        assertEquals(LaunchUrls.Decision.Kind.OPEN, d.change.kind);
        assertEquals(PC + "/mobile.html?x=1&app=3#pair=k", d.change.url);
        assertEquals(PC, d.change.save);
        // [취소] — 기억할 것이 없다(keep 없음 = 저장 없이 처음 쓰기 화면)
        assertNull(d.keep);
    }

    @Test
    public void decideSamePcOpensWithoutAsking() {
        LaunchUrls.Decision d = LaunchUrls.decide(PC + "/mobile.html#agent=a1", PC, 3);
        assertEquals(LaunchUrls.Decision.Kind.OPEN, d.kind);
        assertEquals(PC + "/mobile.html?app=3#agent=a1", d.url);
        assertNull(d.save);
        // 대소문자만 다르거나 기본 포트를 적은 것도 같은 PC
        assertEquals(LaunchUrls.Decision.Kind.OPEN,
                LaunchUrls.decide("https://PC.tail0000.ts.net:47615/mobile.html", PC, 3).kind);
        assertEquals(LaunchUrls.Decision.Kind.OPEN,
                LaunchUrls.decide("https://pc.tail0000.ts.net:443/mobile.html", "https://pc.tail0000.ts.net", 3).kind);
    }

    @Test
    public void decideOtherPcAsksFirst() {
        LaunchUrls.Decision d = LaunchUrls.decide(OTHER + "/mobile.html#pair=k", PC, 3);
        assertEquals(LaunchUrls.Decision.Kind.CONFIRM, d.kind);
        assertEquals("other.tail1111.ts.net:47615", d.host);
        assertNull(d.url);
        assertNull(d.save);
        // [바꾸기] — 새 PC 의 origin 을 기억하고 받은 주소 그대로 연다
        assertEquals(LaunchUrls.Decision.Kind.OPEN, d.change.kind);
        assertEquals(OTHER + "/mobile.html?app=3#pair=k", d.change.url);
        assertEquals(OTHER, d.change.save);
        // [그대로] — 기억한 PC 를 늘 하던 대로 연다(덮지 않음)
        assertEquals(LaunchUrls.Decision.Kind.OPEN, d.keep.kind);
        assertEquals(PC + "/mobile.html?app=3", d.keep.url);
        assertNull(d.keep.save);
    }

    @Test
    public void decideSameHostOtherPortIsAnotherPc() {
        LaunchUrls.Decision d = LaunchUrls.decide("https://pc.tail0000.ts.net:8443/mobile.html", PC, 3);
        assertEquals(LaunchUrls.Decision.Kind.CONFIRM, d.kind);
        assertEquals("pc.tail0000.ts.net:8443", d.host);
        // 포트가 없으면 호스트만
        assertEquals("other.tail1111.ts.net",
                LaunchUrls.decide("https://other.tail1111.ts.net/mobile.html", PC, 3).host);
    }

    @Test
    public void decideRejectedOpensSavedPcWithoutOverwriting() {
        for (String bad : new String[] {"https://evil.example/mobile.html", "http://pc.tail0000.ts.net/", "https://.ts.net/"}) {
            LaunchUrls.Decision d = LaunchUrls.decide(bad, PC, 3);
            assertEquals(bad, LaunchUrls.Decision.Kind.OPEN, d.kind);
            assertEquals(bad, PC + "/mobile.html?app=3", d.url);
            assertNull(bad, d.save);
        }
    }

    @Test
    public void decideRejectedWithNothingSavedIsFirstRun() {
        LaunchUrls.Decision d = LaunchUrls.decide("https://evil.example/", null, 3);
        assertEquals(LaunchUrls.Decision.Kind.FIRST_RUN, d.kind);
        assertNull(d.url);
        assertNull(d.save);
    }

    @Test
    public void decideNoAddressOpensSavedOrFirstRun() {
        LaunchUrls.Decision d = LaunchUrls.decide(null, PC, 3);
        assertEquals(LaunchUrls.Decision.Kind.OPEN, d.kind);
        assertEquals(PC + "/mobile.html?app=3", d.url);
        assertNull(d.save);
        assertEquals(LaunchUrls.Decision.Kind.FIRST_RUN, LaunchUrls.decide(null, null, 3).kind);
    }

    @Test
    public void decideReadsOldOrBrokenSavedValues() {
        // 예전 판이 기억한 전체 주소도 origin 으로 읽는다
        assertEquals(PC + "/mobile.html?app=3", LaunchUrls.decide(null, PC + "/mobile.html#agent=a1", 3).url);
        assertEquals(LaunchUrls.Decision.Kind.OPEN,
                LaunchUrls.decide(PC + "/mobile.html", PC + "/mobile.html?x=1", 3).kind);
        // 못 읽거나 *.ts.net 이 아닌 값은 기억한 게 없는 것으로
        assertEquals(LaunchUrls.Decision.Kind.FIRST_RUN, LaunchUrls.decide(null, "not a url", 3).kind);
        assertEquals(LaunchUrls.Decision.Kind.FIRST_RUN, LaunchUrls.decide(null, "https://evil.example", 3).kind);
        // 망가진 기억값도 기억 없음과 같다 — 묻는다
        LaunchUrls.Decision d = LaunchUrls.decide(PC + "/mobile.html", "https://evil.example", 3);
        assertEquals(LaunchUrls.Decision.Kind.CONFIRM, d.kind);
        assertEquals(PC, d.change.save);
        assertNull(d.keep);
    }
}
