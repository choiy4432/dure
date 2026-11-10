package io.github.choiy4432.dure;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** 주소 다루기와 시작 화면이 할 일 — 순수 Java(android.net.Uri 를 쓰지 않는다)라 기기 없이 JUnit 으로 시험한다(LaunchUrlsTest) */
final class LaunchUrls {
    private static final String TAILNET = ".ts.net";
    /** 받은 주소 없이 열 때의 화면 — 기억한 PC 의 origin 뒤에 붙인다 */
    static final String HOME = "/mobile.html";

    private LaunchUrls() {}

    /** 시작 화면이 할 일 — 열기(먼저 기억할 origin 이 있으면 기억) · 다른 PC 로 바꿀지 묻기 · 처음 쓰기 */
    static final class Decision {
        enum Kind { OPEN, CONFIRM, FIRST_RUN }

        final Kind kind;
        /** OPEN: 열 주소(?app= 를 실었다) */
        final String url;
        /** OPEN: 열기 전에 기억할 origin — null 이면 기억한 것을 그대로 둔다 */
        final String save;
        /** CONFIRM: 새 PC 의 호스트[:포트] — 묻는 창에 보인다 */
        final String host;
        /** CONFIRM: [바꾸기] 를 누르면 할 일(OPEN — 새 PC 를 기억하고 받은 주소를 연다) */
        final Decision change;
        /** CONFIRM: [그대로] 를 누르면 할 일(OPEN — 기억한 PC 를 늘 하던 대로 연다) · 기억한 PC 가 없는 첫 확인이면 null([취소] = 저장 없이 처음 쓰기) */
        final Decision keep;

        private Decision(Kind kind, String url, String save, String host, Decision change, Decision keep) {
            this.kind = kind;
            this.url = url;
            this.save = save;
            this.host = host;
            this.change = change;
            this.keep = keep;
        }

        static Decision open(String url, String save) {
            return new Decision(Kind.OPEN, url, save, null, null, null);
        }

        static Decision confirm(String host, Decision change, Decision keep) {
            return new Decision(Kind.CONFIRM, null, null, host, change, keep);
        }

        static Decision firstRun() {
            return new Decision(Kind.FIRST_RUN, null, null, null, null, null);
        }
    }

    /**
     * 무엇을 할지 — received: VIEW 인텐트로 받은 주소(없으면 null) · saved: 기억한 값(없으면 null) · versionCode: 앱 판(?app=).
     * - 받은 주소가 맞으면(https *.ts.net): 같은 PC 면 그냥 열기 · 기억한 게 없거나 다른 PC 면 묻기(기억한 게 없을 때의 [취소] = keep 이 null)
     *   (*.ts.net 이면 Funnel 로 공개된 남의 주소일 수도 있다 — 모르는 새 PC 로 몰래 바뀌지 않게)
     * - 받은 주소가 없거나 맞지 않으면: 기억한 PC 의 origin + /mobile.html 을 열기(기억한 것은 덮지 않는다) · 그것도 없으면 처음 쓰기
     * 기억은 origin 만 한다 — 받은 주소의 경로·쿼리·#(짝 맺기 열쇠·깊은 링크)은 그때 한 번만 연다.
     */
    static Decision decide(String received, String saved, int versionCode) {
        String savedOrigin = acceptedOrigin(saved);
        Decision keep = savedOrigin == null ? null : Decision.open(launchUrl(savedOrigin + HOME, versionCode), null);
        String url = acceptedUrl(received);
        if (url == null) return keep == null ? Decision.firstRun() : keep;
        String origin = originOf(url);
        if (savedOrigin != null && origin.equals(savedOrigin)) return Decision.open(launchUrl(url, versionCode), null);
        // 기억한 PC 가 없을 때(keep == null)도 묻는다 — 거절하면 아무것도 기억하지 않고 처음 쓰기 화면
        return Decision.confirm(origin.substring(origin.indexOf("://") + 3), Decision.open(launchUrl(url, versionCode), origin), keep);
    }

    /** 받은 주소를 쓸지 — https 이고 호스트가 *.ts.net(Tailscale)이면 그 주소 그대로, 아니면 null(아무 사이트나 앱으로 열지 않게) */
    static String acceptedUrl(String received) {
        URI u = parse(received);
        if (u == null || !"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null) return null;
        String host = u.getHost().toLowerCase(Locale.ROOT);
        return host.endsWith(TAILNET) && host.length() > TAILNET.length() ? received : null;
    }

    /** 쓸 수 있는 주소의 origin — 아니면 null(기억한 값도 이것으로 읽는다: 예전 판의 전체 주소 · 망가진 값) */
    static String acceptedOrigin(String url) {
        return originOf(acceptedUrl(url));
    }

    /** 열 주소 — 쿼리에 app=<앱 판> 을 더한다(있던 app= 은 바꾼다). 포트·경로·#… 는 글 그대로 둔다 */
    static String launchUrl(String url, int versionCode) {
        int hash = url.indexOf('#');
        String head = hash < 0 ? url : url.substring(0, hash);
        String fragment = hash < 0 ? "" : url.substring(hash);
        int q = head.indexOf('?');
        StringBuilder out = new StringBuilder(q < 0 ? head : head.substring(0, q)).append('?');
        if (q >= 0) {
            for (String part : head.substring(q + 1).split("&")) {
                if (part.isEmpty() || part.equals("app") || part.startsWith("app=")) continue;
                out.append(part).append('&');
            }
        }
        return out.append("app=").append(versionCode).append(fragment).toString();
    }

    /** 주소의 origin(scheme://호스트[:포트]) — 브라우저처럼 소문자로, https 의 443 은 뺀다. 못 읽으면 null */
    static String originOf(String url) {
        URI u = parse(url);
        if (u == null || u.getScheme() == null || u.getHost() == null) return null;
        String scheme = u.getScheme().toLowerCase(Locale.ROOT);
        int port = u.getPort();
        boolean defaultPort = port < 0 || (port == 443 && scheme.equals("https"));
        return scheme + "://" + u.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }

    private static URI parse(String s) {
        if (s == null) return null;
        try {
            return new URI(s);
        } catch (URISyntaxException e) {
            return null;
        }
    }
}
