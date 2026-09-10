import type { HardwareInfo, Snapshot } from '../../api/types';
import { Badge, DataList, EmptyState } from '../../components/Display';
import { Pane, Panes } from '../../components/Pane';
import styles from './HardwareView.module.css';

interface HardwareViewProps {
  snapshot: Snapshot | null;
  hardware: HardwareInfo | null;
}

/** 硬件页：只陈列服务器实际报告的东西，不做能力推断。 */
export function HardwareView({ snapshot, hardware }: HardwareViewProps) {
  const devices = hardware?.devices ?? [];

  return (
    <Panes columns={2}>
      <Pane
        title="DRM 设备"
        description="来自 /dev/dri 与 sysfs 的真实节点；程序不会依据型号推断任何编码能力。"
      >
        {hardware === null ? (
          <EmptyState title="正在读取设备" />
        ) : devices.length === 0 ? (
          <EmptyState
            title="没有发现 render node"
            hint="容器里通常看不到宿主机的 /dev/dri；在裸机 NAS 上这里会列出 renderD128 等节点。"
          />
        ) : (
          <ul className={styles.devices}>
            {devices.map((device) => (
              <li className={styles.device} key={device.id}>
                <header className={styles.deviceHead}>
                  {/* 有型号就用型号当标题，认卡比看 PCI 地址直观得多。 */}
                  <span className={styles.deviceId}>
                    {device.deviceName || device.pciAddress || device.id}
                  </span>
                  {device.driver ? <Badge tone="accent">{device.driver}</Badge> : null}
                </header>

                <DataList
                  dense
                  items={[
                    { label: '型号', value: device.deviceName || '—' },
                    { label: '厂商', value: device.vendorName || '—' },
                    { label: 'render node', value: device.renderNode ?? '—' },
                    { label: 'card node', value: device.cardNode ?? '—' },
                    { label: 'PCI', value: device.pciAddress ?? '—' },
                    { label: 'vendor / device id', value: `${device.vendor ?? '—'} / ${device.deviceId ?? '—'}` },
                    { label: 'sysfs', value: device.sysfsPath ?? '—' },
                  ]}
                />

                {device.properties && Object.keys(device.properties).length > 0 ? (
                  <details className={styles.raw}>
                    <summary className={styles.rawSummary}>uevent 原始内容</summary>
                    <pre className={styles.pre}>
                      {Object.entries(device.properties)
                        .map(([key, value]) => `${key}=${value}`)
                        .join('\n')}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Pane>

      <Pane
        title="FFmpeg 与加速方法"
        description="硬件加速方法来自 ffmpeg -hwaccels，是否真正可用取决于驱动与设备权限。"
      >
        {snapshot === null ? (
          <EmptyState title="正在读取 FFmpeg 能力" />
        ) : (
          <>
            <div className={styles.chips}>
              {snapshot.hwaccels.length === 0 ? (
                <span className={styles.muted}>这个 ffmpeg 没有报告任何硬件加速方法。</span>
              ) : (
                snapshot.hwaccels.map((item) => (
                  <Badge tone="accent" mono key={item}>
                    {item}
                  </Badge>
                ))
              )}
            </div>

            <DataList
              items={[
                { label: '操作系统', value: hardware ? `${hardware.os} / ${hardware.arch}` : '—' },
                { label: 'FFmpeg', value: snapshot.ffmpegPath },
                { label: 'FFprobe', value: snapshot.ffprobePath },
                { label: '版本', value: snapshot.version },
                { label: '查询时间', value: new Date(snapshot.generatedAt).toLocaleString() },
                {
                  label: '编码器 / 解码器',
                  value: `${snapshot.encoders.length} / ${snapshot.decoders.length}`,
                },
                {
                  label: '滤镜 / 格式',
                  value: `${snapshot.filters.length} / ${snapshot.formats.length}`,
                },
              ]}
            />

            <details className={styles.raw}>
              <summary className={styles.rawSummary}>ffmpeg -version 原始输出</summary>
              <pre className={styles.pre}>{snapshot.buildConfig}</pre>
            </details>
          </>
        )}
      </Pane>
    </Panes>
  );
}