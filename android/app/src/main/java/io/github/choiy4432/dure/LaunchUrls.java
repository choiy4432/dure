package io.github.choiy4432.dure;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** 주소 다루기 — 순수 Java(android.net.Uri 를 쓰지 않는다)라 기기 없이 JUnit 으로 시험한다(LaunchUrlsTest) */
final class LaunchUrls {
    private static final String TAILNET = ".ts.net";

    private LaunchUrls() {}

    /** 받은 주소를 쓸지 — https 이고 호스트가 *.ts.net(Tailscale)이면 그 주소 그대로, 아니면 null(아무 사이트나 앱으로 열지 않게) */
    static String acceptedUrl(String received) {
        URI u = parse(received);
        if (u == null || !"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null) return null;
        String host = u.getHost().toLowerCase(Locale.ROOT);
        return host.endsWith(TAILNET) && host.length() > TAILNET.length() ? received : null;
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

    /** 주소의 origin(scheme://호스트[:포트]) — 못 읽으면 null */
    static String originOf(String url) {
        URI u = parse(url);
        if (u == null || u.getScheme() == null || u.getHost() == null) return null;
        return u.getScheme().toLowerCase(Locale.ROOT) + "://" + u.getHost() + (u.getPort() >= 0 ? ":" + u.getPort() : "");
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
