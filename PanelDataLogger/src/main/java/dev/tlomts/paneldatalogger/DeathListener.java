package dev.tlomts.paneldatalogger;

import org.bukkit.Location;
import org.bukkit.entity.Entity;
import org.bukkit.entity.LivingEntity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.PlayerDeathEvent;

import java.util.Locale;

/**
 * يسجّل موقع كل حالة وفاة للاعب فور حدوثها — قبل أن يُنقَل لنقطة الإحياء،
 * لذلك الإحداثيات المسجّلة هي إحداثيات مكان الوفاة الفعلي دائماً.
 */
public class DeathListener implements Listener {

    private final PanelDataLogger plugin;

    public DeathListener(PanelDataLogger plugin) {
        this.plugin = plugin;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDeath(PlayerDeathEvent event) {
        Player player = event.getEntity();
        Location loc = player.getLocation();
        String cause = describeCause(player);

        String line = String.format(Locale.US,
                "[PanelData] DEATH|%s|%s|%.2f|%.2f|%.2f|%s",
                player.getName(),
                loc.getWorld() != null ? loc.getWorld().getName() : "unknown",
                loc.getX(), loc.getY(), loc.getZ(),
                PanelDataLogger.sanitize(cause));

        plugin.getLogger().info(line);
    }

    /** يبني وصفاً مختصراً لسبب الوفاة اعتماداً على آخر ضرر مُسجَّل، مع اسم المهاجم إن وُجد */
    private String describeCause(LivingEntity victim) {
        EntityDamageEvent last = victim.getLastDamageCause();
        if (last == null) return "UNKNOWN";

        EntityDamageEvent.DamageCause causeEnum = last.getCause();

        if (last instanceof EntityDamageByEntityEvent byEntity) {
            Entity damager = byEntity.getDamager();
            if (damager instanceof Player p) {
                return causeEnum.name() + ":PLAYER:" + p.getName();
            } else if (damager != null) {
                return causeEnum.name() + ":MOB:" + damager.getType().name();
            }
        }
        return causeEnum.name();
    }
}
