package dev.tlomts.paneldatalogger;

import org.bukkit.plugin.java.JavaPlugin;

import java.io.IOException;

/**
 * PanelDataLogger
 * ────────────────
 * إضافة صغيرة مرافقة لمشروع MC Panel، بمهمتين مستقلتين:
 *
 * 1) خادم HTTP مدمج (127.0.0.1 فقط) يقدّم بيانات اللاعبين المتصلين حيّاً
 *    (مخزون/موقع/صحة) للوحة عند طلبها — مباشرة من كائن اللاعب في الذاكرة،
 *    بلا انتظار حفظ ملف ولا تحليل كونسول. هذا نفس أسلوب إضافات معروفة مثل
 *    MCRest وWEB-API. المنفذ يُضبط في config.yml (افتراضي 28281) ويجب أن
 *    يطابق PANEL_HTTP_PORT في ملف .env الخاص باللوحة.
 *
 * 2) تسجيل إحداثيات كل وفاة وكل انتقال في الكونسول بصيغة يقرأها server.js
 *    الخاص باللوحة (يبقى ضرورياً لأن Vanilla لا يكتب هذه الإحداثيات أصلاً،
 *    وخادم الـ HTTP في (1) لا يغطي الأحداث التاريخية، فقط الحالة اللحظية):
 *
 *   [PanelData] DEATH|<player>|<world>|<x>|<y>|<z>|<cause>
 *   [PanelData] TELEPORT|<player>|<cause>|<fromWorld>|<fx>|<fy>|<fz>|<toWorld>|<tx>|<ty>|<tz>
 */
public final class PanelDataLogger extends JavaPlugin {

    private PanelHttpServer httpServer;

    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(new DeathListener(this), this);
        getServer().getPluginManager().registerEvents(new TeleportListener(this), this);

        saveDefaultConfig();
        String bind = getConfig().getString("bind-address", "127.0.0.1");
        int port = getConfig().getInt("port", 28281);
        httpServer = new PanelHttpServer(this);
        try {
            httpServer.start(bind, port);
            getLogger().info("خادم HTTP الداخلي يعمل على " + bind + ":" + port + " (لبيانات اللاعبين الحية للوحة).");
        } catch (IOException e) {
            getLogger().warning("تعذّر تشغيل خادم HTTP الداخلي على المنفذ " + port + ": " + e.getMessage()
                + " — غيّر قيمة port في plugins/PanelDataLogger/config.yml إن كان المنفذ مستخدَماً.");
        }

        getLogger().info("PanelDataLogger جاهزة — تسجيل الوفيات والانتقالات لصالح MC Panel مفعّل.");
    }

    @Override
    public void onDisable() {
        if (httpServer != null) httpServer.stop();
        getLogger().info("PanelDataLogger تم إيقافها.");
    }

    /** يزيل أي أحرف قد تكسر صيغة الأسطر المعتمدة على الفاصل | */
    static String sanitize(String s) {
        if (s == null) return "غير معروف";
        return s.replace("|", "/").replace("\n", " ").replace("\r", " ").trim();
    }
}

