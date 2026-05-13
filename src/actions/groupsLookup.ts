import type { App } from '@slack/bolt';

/**
 * Handler de `block_suggestion` para el `multi_external_select` con
 * `action_id: 'groups'` del modal de creación.
 *
 * Slack envía la query escrita por el usuario en `options.value`. El bot
 * responde con la lista de user groups (subteams) del workspace, opcionalmente
 * filtrados por la query.
 *
 * Requiere el scope `usergroups:read` en el manifest.
 */
export function registerGroupsLookup(app: App) {
  app.options({ action_id: 'groups' }, async ({ ack, options, client, logger }) => {
    try {
      const query = (options.value || '').toLowerCase().trim();
      const res = await client.usergroups.list({ include_users: false });

      if (!res.usergroups || res.usergroups.length === 0) {
        await ack({ options: [] });
        return;
      }

      const filtered = res.usergroups
        // sólo grupos activos y con handle válido
        .filter(g => g.id && g.handle && g.date_delete === 0)
        // filtro por substring sobre handle o name
        .filter(g => {
          if (!query) return true;
          const hay = `${g.handle ?? ''} ${g.name ?? ''}`.toLowerCase();
          return hay.includes(query);
        })
        // Slack limita external_select a 100 opciones
        .slice(0, 100)
        .map(g => {
          const showName = g.name && g.name !== g.handle ? ` · ${g.name}` : '';
          return {
            text: {
              type: 'plain_text' as const,
              text: `@${g.handle}${showName}`.slice(0, 75) // max 75 chars per option
            },
            value: g.id!
          };
        });

      await ack({ options: filtered } as any);
    } catch (err) {
      logger.error({ err }, 'groups_lookup: usergroups.list failed');
      await ack({ options: [] });
    }
  });
}
