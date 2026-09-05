package dev.tlomts.paneldatalogger;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Statistic;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * خادم HTTP صغير مدمج داخل الإضافة نفسها، يستمع فقط على 127.0.0.1 (لا يخرج
 * عن الجهاز إطلاقاً، لا يحتاج مصادقة). يقرأه MC Panel مباشرة بدلاً من تحليل
 * كونسول أو انتظار حفظ ملف — نفس الأسلوب الذي تعتمده إضافات معروفة مثل
 * MCRest وWEB-API لتوصيل بيانات اللاعبين للوحات خارجية.
 *
 * GET /health          → {"status":"ok"}
 * GET /player/<name>   → بيانات اللاعب الحية إن كان متصلاً الآن، وإلا {"online":false}
 */
public class PanelHttpServer {

    private final PanelDataLogger plugin;
    private HttpServer server;

    public PanelHttpServer(PanelDataLogger plugin) {
        this.plugin = plugin;
    }

    public void start(String bindAddress, int port) throws IOException {
        server = HttpServer.create(new InetSocketAddress(bindAddress, port), 0);
        server.createContext("/health", this::handleHealth);
        server.createContext("/player/", this::handlePlayer);
        server.setExecutor(Executors.newCachedThreadPool());
        server.start();
    }

    public void stop() {
        if (server != null) server.stop(0);
    }

    private void handleHealth(HttpExchange ex) throws IOException {
        sendJson(ex, 200, "{\"status\":\"ok\"}");
    }

    private void handlePlayer(HttpExchange ex) throws IOException {
        String path = ex.getRequestURI().getPath();
        String name = path.length() > "/player/".length() ? path.substring("/player/".length()) : "";
        if (name.isEmpty()) { sendJson(ex, 400, "{\"error\":\"missing player name\"}"); return; }

        try {
            String json = queryOnMainThread(name).get(2, TimeUnit.SECONDS);
            sendJson(ex, 200, json);
        } catch (TimeoutException e) {
            sendJson(ex, 504, "{\"error\":\"timeout waiting for main server thread\"}");
        } catch (Exception e) {
            sendJson(ex, 500, "{\"error\":\"" + esc(e.getMessage()) + "\"}");
        }
    }

    /** الوصول لكائنات Bukkit (اللاعب، المخزون...) يجب أن يتم من الترد الرئيسي دائماً */
    private CompletableFuture<String> queryOnMainThread(String name) {
        CompletableFuture<String> future = new CompletableFuture<>();
        Bukkit.getScheduler().runTask(plugin, () -> {
            try {
                Player p = Bukkit.getPlayerExact(name);
                future.complete(p == null ? "{\"online\":false}" : serializePlayer(p));
            } catch (Exception e) {
                future.completeExceptionally(e);
            }
        });
        return future;
    }

    private String serializePlayer(Player p) {
        Location loc = p.getLocation();
        PlayerInventory pinv = p.getInventory();

        String main = itemArray(pinv.getContents(), 0);
        ItemStack[] armorRaw = pinv.getArmorContents(); // ترتيب Bukkit: [0]حذاء [1]بنطال [2]درع [3]خوذة
        String armor = "{"
            + "\"boots\":" + itemOrNull(armorRaw.length > 0 ? armorRaw[0] : null) + ","
            + "\"leggings\":" + itemOrNull(armorRaw.length > 1 ? armorRaw[1] : null) + ","
            + "\"chestplate\":" + itemOrNull(armorRaw.length > 2 ? armorRaw[2] : null) + ","
            + "\"helmet\":" + itemOrNull(armorRaw.length > 3 ? armorRaw[3] : null)
            + "}";
        String offhand = itemOrNull(pinv.getItemInOffHand());
        String enderChest = itemArray(p.getEnderChest().getContents(), 0);

        return "{"
            + "\"online\":true,"
            + "\"dimension\":\"" + p.getWorld().getEnvironment().name() + "\","
            + "\"world\":\"" + esc(p.getWorld().getName()) + "\","
            + "\"pos\":{\"x\":" + loc.getX() + ",\"y\":" + loc.getY() + ",\"z\":" + loc.getZ() + "},"
            + "\"health\":" + p.getHealth() + ","
            + "\"maxHealth\":" + p.getMaxHealth() + ","
            + "\"food\":" + p.getFoodLevel() + ","
            + "\"xpLevel\":" + p.getLevel() + ","
            + "\"xpTotal\":" + p.getTotalExperience() + ","
            + "\"gameMode\":\"" + p.getGameMode().name() + "\","
            + "\"inventory\":" + main + ","
            + "\"armor\":" + armor + ","
            + "\"offhand\":" + offhand + ","
            + "\"enderChest\":" + enderChest + ","
            + "\"stats\":" + liveStats(p)
            + "}";
    }

    /** إحصائيات حية عبر Player#getStatistic — لا تنتظر حفظ ملف إطلاقاً */
    private String liveStats(Player p) {
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"deaths\":").append(safeStat(p, Statistic.DEATHS)).append(",");
        sb.append("\"playerKills\":").append(safeStat(p, Statistic.PLAYER_KILLS)).append(",");
        sb.append("\"mobKills\":").append(safeStat(p, Statistic.MOB_KILLS)).append(",");
        sb.append("\"playTimeTicks\":").append(safeStat(p, Statistic.PLAY_ONE_MINUTE)).append(",");
        sb.append("\"distances\":{");
        sb.append("\"walk\":").append(safeStat(p, Statistic.WALK_ONE_CM) / 100.0).append(",");
        sb.append("\"sprint\":").append(safeStat(p, Statistic.SPRINT_ONE_CM) / 100.0).append(",");
        sb.append("\"swim\":").append(safeStat(p, Statistic.SWIM_ONE_CM) / 100.0).append(",");
        sb.append("\"fall\":").append(safeStat(p, Statistic.FALL_ONE_CM) / 100.0).append(",");
        sb.append("\"climb\":").append(safeStat(p, Statistic.CLIMB_ONE_CM) / 100.0).append(",");
        sb.append("\"boat\":").append(safeStat(p, Statistic.BOAT_ONE_CM) / 100.0).append(",");
        sb.append("\"elytra\":").append(safeStat(p, Statistic.AVIATE_ONE_CM) / 100.0).append(",");
        sb.append("\"horse\":").append(safeStat(p, Statistic.HORSE_ONE_CM) / 100.0);
        sb.append("}}");
        return sb.toString();
    }

    /** بعض إصدارات الـ API قد لا تدعم إحصائية معينة — لا نكسر الرد كاملاً بسببها */
    private long safeStat(Player p, Statistic s) {
        try { return p.getStatistic(s); } catch (Throwable t) { return 0L; }
    }

    private String itemArray(ItemStack[] contents, int startSlot) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (int i = 0; i < contents.length; i++) {
            ItemStack it = contents[i];
            if (it == null || it.getType().isAir()) continue;
            if (!first) sb.append(",");
            first = false;
            sb.append("{\"slot\":").append(startSlot + i).append(",").append(itemFields(it)).append("}");
        }
        sb.append("]");
        return sb.toString();
    }

    private String itemOrNull(ItemStack it) {
        if (it == null || it.getType().isAir()) return "null";
        return "{" + itemFields(it) + "}";
    }

    /** الحقول المشتركة لأي قطعة: المعرّف، العدد، السحر التفصيلي، والمتانة إن وُجدت */
    private String itemFields(ItemStack it) {
        StringBuilder sb = new StringBuilder();
        sb.append("\"id\":\"").append(esc(it.getType().name().toLowerCase())).append("\"")
          .append(",\"count\":").append(it.getAmount())
          .append(",\"enchanted\":").append(!it.getEnchantments().isEmpty())
          .append(",\"enchantments\":[");
        boolean firstEnch = true;
        for (java.util.Map.Entry<org.bukkit.enchantments.Enchantment, Integer> e : it.getEnchantments().entrySet()) {
            if (!firstEnch) sb.append(",");
            firstEnch = false;
            sb.append("{\"id\":\"").append(esc(e.getKey().getKey().getKey())).append("\",\"level\":").append(e.getValue()).append("}");
        }
        sb.append("]");
        short maxDur = it.getType().getMaxDurability();
        if (maxDur > 0 && it.getItemMeta() instanceof org.bukkit.inventory.meta.Damageable) {
            int dmg = ((org.bukkit.inventory.meta.Damageable) it.getItemMeta()).getDamage();
            sb.append(",\"durability\":{\"current\":").append(maxDur - dmg).append(",\"max\":").append(maxDur).append("}");
        }
        // زخرفة الدروع (Trim) — معلومة تجميلية فقط عبر السنبدك، لا تؤثر على القيم
        try {
            if (it.hasItemMeta() && it.getItemMeta() instanceof org.bukkit.inventory.meta.ArmorMeta) {
                org.bukkit.inventory.meta.ArmorMeta am = (org.bukkit.inventory.meta.ArmorMeta) it.getItemMeta();
                if (am.hasTrim()) {
                    org.bukkit.inventory.meta.trim.ArmorTrim trim = am.getTrim();
                    sb.append(",\"trim\":{\"pattern\":\"").append(esc(trim.getPattern().getKey().getKey()))
                      .append("\",\"material\":\"").append(esc(trim.getMaterial().getKey().getKey())).append("\"}");
                }
            }
        } catch (Throwable ignored) { /* لو تغيّرت الواجهة البرمجية بين الإصدارات، نتجاهل الزخرفة بدل كسر الرد كله */ }
        // محتويات صندوق شولكر متداخل داخل هذه القطعة نفسها — حتى 27 عنصراً
        try {
            if (it.hasItemMeta() && it.getItemMeta() instanceof org.bukkit.inventory.meta.BlockStateMeta) {
                org.bukkit.inventory.meta.BlockStateMeta bsm = (org.bukkit.inventory.meta.BlockStateMeta) it.getItemMeta();
                if (bsm.getBlockState() instanceof org.bukkit.block.ShulkerBox) {
                    org.bukkit.block.ShulkerBox shulker = (org.bukkit.block.ShulkerBox) bsm.getBlockState();
                    sb.append(",\"contents\":").append(itemArray(shulker.getInventory().getContents(), 0));
                }
            }
        } catch (Throwable ignored) {}
        return sb.toString();
    }

    private String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private void sendJson(HttpExchange ex, int status, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(bytes); }
    }
}
