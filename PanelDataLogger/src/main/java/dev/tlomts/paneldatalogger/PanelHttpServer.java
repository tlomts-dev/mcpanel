package dev.tlomts.paneldatalogger;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.Statistic;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.PlayerInventory;

import java.io.IOException;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * خادم HTTP صغير مدمج داخل الإضافة نفسها، يستمع فقط على 127.0.0.1 (لا يخرج
 * عن الجهاز إطلاقاً، لا يحتاج مصادقة). يقرأه MC Panel مباشرة بدلاً من تحليل
 * كونسول أو انتظار حفظ ملف.
 *
 * Small HTTP server embedded in the plugin, listening on 127.0.0.1 only.
 * MC Panel reads it instead of parsing the console or waiting for a save.
 *
 * GET /health          -> {"status":"ok"}
 * GET /player/NAME     -> live player data if online now, otherwise {"online":false}
 *
 * Version independence: this class is compiled against an old Bukkit API (1.13)
 * with Java 8 bytecode and only touches API that exists on every version since.
 * Anything that was added, renamed or removed later (max health, statistic names,
 * armor trims, enchantment keys) goes through reflection or a name lookup with a
 * safe fallback, so one jar runs on 1.13 up to the newest release.
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
            sendJson(ex, 500, "{\"error\":\"" + esc(String.valueOf(e.getMessage())) + "\"}");
        }
    }

    /** Bukkit objects (player, inventory...) must always be accessed from the main thread. */
    private CompletableFuture<String> queryOnMainThread(String name) {
        CompletableFuture<String> future = new CompletableFuture<>();
        Bukkit.getScheduler().runTask(plugin, () -> {
            try {
                Player p = Bukkit.getPlayerExact(name);
                future.complete(p == null ? "{\"online\":false}" : serializePlayer(p));
            } catch (Throwable e) {
                future.completeExceptionally(e);
            }
        });
        return future;
    }

    private String serializePlayer(Player p) {
        Location loc = p.getLocation();
        PlayerInventory pinv = p.getInventory();

        String main = itemArray(pinv.getContents());
        ItemStack[] armorRaw = pinv.getArmorContents(); // Bukkit order: [0] boots [1] leggings [2] chestplate [3] helmet
        String armor = "{"
            + "\"boots\":" + itemOrNull(armorRaw.length > 0 ? armorRaw[0] : null) + ","
            + "\"leggings\":" + itemOrNull(armorRaw.length > 1 ? armorRaw[1] : null) + ","
            + "\"chestplate\":" + itemOrNull(armorRaw.length > 2 ? armorRaw[2] : null) + ","
            + "\"helmet\":" + itemOrNull(armorRaw.length > 3 ? armorRaw[3] : null)
            + "}";
        String offhand = itemOrNull(pinv.getItemInOffHand());
        String enderChest = itemArray(p.getEnderChest().getContents());

        return "{"
            + "\"online\":true,"
            + "\"dimension\":\"" + p.getWorld().getEnvironment().name() + "\","
            + "\"world\":\"" + esc(p.getWorld().getName()) + "\","
            + "\"pos\":{\"x\":" + loc.getX() + ",\"y\":" + loc.getY() + ",\"z\":" + loc.getZ() + "},"
            + "\"health\":" + p.getHealth() + ","
            + "\"maxHealth\":" + maxHealth(p) + ","
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

    /** Player#getMaxHealth is deprecated and may disappear, so call it reflectively. */
    private double maxHealth(Player p) {
        try {
            Method m = p.getClass().getMethod("getMaxHealth");
            return ((Number) m.invoke(p)).doubleValue();
        } catch (Throwable t) {
            return 20.0;
        }
    }

    /** Live statistics via Player#getStatistic, no waiting for a file save. */
    private String liveStats(Player p) {
        StringBuilder sb = new StringBuilder("{");
        sb.append("\"deaths\":").append(stat(p, "DEATHS")).append(",");
        sb.append("\"playerKills\":").append(stat(p, "PLAYER_KILLS")).append(",");
        sb.append("\"mobKills\":").append(stat(p, "MOB_KILLS")).append(",");
        sb.append("\"playTimeTicks\":").append(stat(p, "PLAY_ONE_MINUTE", "PLAY_ONE_TICK", "TOTAL_WORLD_TIME")).append(",");
        sb.append("\"distances\":{");
        sb.append("\"walk\":").append(stat(p, "WALK_ONE_CM") / 100.0).append(",");
        sb.append("\"sprint\":").append(stat(p, "SPRINT_ONE_CM") / 100.0).append(",");
        sb.append("\"swim\":").append(stat(p, "SWIM_ONE_CM") / 100.0).append(",");
        sb.append("\"fall\":").append(stat(p, "FALL_ONE_CM") / 100.0).append(",");
        sb.append("\"climb\":").append(stat(p, "CLIMB_ONE_CM") / 100.0).append(",");
        sb.append("\"boat\":").append(stat(p, "BOAT_ONE_CM") / 100.0).append(",");
        sb.append("\"elytra\":").append(stat(p, "AVIATE_ONE_CM") / 100.0).append(",");
        sb.append("\"horse\":").append(stat(p, "HORSE_ONE_CM") / 100.0);
        sb.append("}}");
        return sb.toString();
    }

    /**
     * Statistic constants were renamed across versions. Look them up by name, trying
     * each candidate, and never let a missing one break the whole response.
     */
    private long stat(Player p, String... names) {
        for (String name : names) {
            try {
                Statistic s = Statistic.valueOf(name);
                return p.getStatistic(s);
            } catch (Throwable ignored) { /* try the next name */ }
        }
        return 0L;
    }

    private boolean isEmpty(ItemStack it) {
        if (it == null) return true;
        Material t = it.getType();
        // Material#isAir only exists on newer APIs; AIR, CAVE_AIR and VOID_AIR all end with AIR.
        return t == Material.AIR || t.name().endsWith("_AIR") || it.getAmount() <= 0;
    }

    private String itemArray(ItemStack[] contents) {
        StringBuilder sb = new StringBuilder("[");
        boolean first = true;
        for (int i = 0; i < contents.length; i++) {
            ItemStack it = contents[i];
            if (isEmpty(it)) continue;
            if (!first) sb.append(",");
            first = false;
            sb.append("{\"slot\":").append(i).append(",").append(itemFields(it)).append("}");
        }
        sb.append("]");
        return sb.toString();
    }

    private String itemOrNull(ItemStack it) {
        if (isEmpty(it)) return "null";
        return "{" + itemFields(it) + "}";
    }

    /** Fields shared by every item: id, count, enchantments, durability, trim and shulker contents. */
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
            sb.append("{\"id\":\"").append(esc(enchantId(e.getKey()))).append("\",\"level\":").append(e.getValue()).append("}");
        }
        sb.append("]");
        short maxDur = it.getType().getMaxDurability();
        if (maxDur > 0 && it.getItemMeta() instanceof org.bukkit.inventory.meta.Damageable) {
            int dmg = ((org.bukkit.inventory.meta.Damageable) it.getItemMeta()).getDamage();
            sb.append(",\"durability\":{\"current\":").append(Math.max(0, maxDur - dmg)).append(",\"max\":").append(maxDur).append("}");
        }
        String trim = trimJson(it);
        if (trim != null) sb.append(",\"trim\":").append(trim);
        // Contents of a shulker box item, up to 27 stacks.
        try {
            if (it.hasItemMeta() && it.getItemMeta() instanceof org.bukkit.inventory.meta.BlockStateMeta) {
                org.bukkit.inventory.meta.BlockStateMeta bsm = (org.bukkit.inventory.meta.BlockStateMeta) it.getItemMeta();
                if (bsm.getBlockState() instanceof org.bukkit.block.ShulkerBox) {
                    org.bukkit.block.ShulkerBox shulker = (org.bukkit.block.ShulkerBox) bsm.getBlockState();
                    sb.append(",\"contents\":").append(itemArray(shulker.getInventory().getContents()));
                }
            }
        } catch (Throwable ignored) { /* cosmetic only */ }
        return sb.toString();
    }

    /** Enchantment keys exist since 1.13; fall back to the legacy name just in case. */
    private String enchantId(org.bukkit.enchantments.Enchantment e) {
        try {
            return e.getKey().getKey();
        } catch (Throwable t) {
            return e.getName().toLowerCase();
        }
    }

    /**
     * Armor trims were added in 1.19.4 and their classes changed shape later, so they are
     * read entirely through reflection. Returns null on versions without trims.
     */
    private String trimJson(ItemStack it) {
        try {
            if (!it.hasItemMeta()) return null;
            Object meta = it.getItemMeta();
            Class<?> armorMeta = Class.forName("org.bukkit.inventory.meta.ArmorMeta");
            if (!armorMeta.isInstance(meta)) return null;
            if (!(Boolean) armorMeta.getMethod("hasTrim").invoke(meta)) return null;
            Object trim = armorMeta.getMethod("getTrim").invoke(meta);
            Object pattern = trim.getClass().getMethod("getPattern").invoke(trim);
            Object material = trim.getClass().getMethod("getMaterial").invoke(trim);
            String pat = keyOf(pattern);
            String mat = keyOf(material);
            if (pat == null || mat == null) return null;
            return "{\"pattern\":\"" + esc(pat) + "\",\"material\":\"" + esc(mat) + "\"}";
        } catch (Throwable t) {
            return null;
        }
    }

    private String keyOf(Object keyed) throws Exception {
        Object namespaced = keyed.getClass().getMethod("getKey").invoke(keyed);
        return (String) namespaced.getClass().getMethod("getKey").invoke(namespaced);
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
