package dev.tlomts.paneldatalogger;

import org.bukkit.Location;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerTeleportEvent;

import java.util.Locale;

/**
 * يسجّل كل انتقال "حقيقي" للاعب (بوابة نذر/إند، لؤلؤة إندر، ثمرة كورس،
 * أمر /tp، أو أي إضافة أخرى تستخدم PlayerTeleportEvent). يتجاهل الانتقالات
 * التافهة (أقل من 3 كتل ضمن نفس العالم) لتقليل الضجيج في السجل.
 */
public class TeleportListener implements Listener {

    private static final double MIN_DISTANCE = 3.0;

    private final PanelDataLogger plugin;

    public TeleportListener(PanelDataLogger plugin) {
        this.plugin = plugin;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onTeleport(PlayerTeleportEvent event) {
        Location from = event.getFrom();
        Location to   = event.getTo();
        if (from == null || to == null || to.getWorld() == null || from.getWorld() == null) return;

        boolean worldChanged = !from.getWorld().equals(to.getWorld());
        double distance = worldChanged ? Double.MAX_VALUE : from.distance(to);
        if (!worldChanged && distance < MIN_DISTANCE) return;

        String cause = event.getCause() != null ? event.getCause().name() : "UNKNOWN";

        String line = String.format(Locale.US,
                "[PanelData] TELEPORT|%s|%s|%s|%.2f|%.2f|%.2f|%s|%.2f|%.2f|%.2f",
                event.getPlayer().getName(),
                PanelDataLogger.sanitize(cause),
                from.getWorld().getName(), from.getX(), from.getY(), from.getZ(),
                to.getWorld().getName(), to.getX(), to.getY(), to.getZ());

        plugin.getLogger().info(line);
    }
}
