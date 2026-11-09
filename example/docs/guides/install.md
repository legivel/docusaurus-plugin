import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Install a node

A node needs a machine with 4 GB of memory and a fixed address. The daily routine is in [Operate a node](./operate.md); the ledger fields are in the [reference](/docs/reference/fields#the-fields).

## Steps

1. Download the release.
2. Unpack it into `/opt/grid`.
3. Start the service:

```bash title="/etc/grid/start.sh" showLineNumbers
sudo systemctl enable --now grid-node
```

<Tabs>
  <TabItem value="linux" label="Linux">Use the systemd unit above.</TabItem>
  <TabItem value="mac" label="macOS">
Use launchd instead:

```bash
launchctl load ~/Library/LaunchAgents/grid.plist
```
  </TabItem>
</Tabs>

:::warning Keys
Rotate the key monthly. The command:

```bash
grid key rotate
```
:::

## Check

| Check | Command | Expected |
|---|---|---|
| Service | `systemctl status grid-node` | active |
| Peers | `grid peers` | at least 3 |
