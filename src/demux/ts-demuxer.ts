/*
 * Copyright (C) 2021 magicxqq. All Rights Reserved.
 *
 * @author magicxqq <xqq@xqq.im>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import Log from '../utils/logger.js';
import DemuxErrors from './demux-errors.js';
import MediaInfo from '../core/media-info';
import {IllegalStateException} from '../utils/exception.js';
import BaseDemuxer from './base-demuxer';
import { PAT, PESQueue, PIDPESQueues, PMT, ProgramPMTMap, StreamType } from './pat-pmt-pes';

class TSDemuxer extends BaseDemuxer {

    private readonly TAG: string = "TSDemuxer";

    private config_: any;
    private ts_packet_size_: number;
    private sync_offset_: number;
    private first_parse_: boolean = true;
    private do_dispatch_: boolean;

    private media_info_ = new MediaInfo();

    private pat_: PAT;
    private current_program_: number;
    private current_pmt_pid_: number = -1;
    private pmt_: PMT;
    private program_pmt_map_: ProgramPMTMap = {};

    private pid_pes_queues_: PIDPESQueues = {};

    private video_track_ = {type: 'video', id: 1, sequenceNumber: 0, samples: [], length: 0};
    private audio_track_ = {type: 'audio', id: 2, sequenceNumber: 0, samples: [], length: 0};

    public constructor(probe_data: any, config: any) {
        super();

        this.ts_packet_size_ = probe_data.ts_packet_size;
        this.sync_offset_ = probe_data.sync_offset;
        this.config_ = config;
    }

    public destroy() {
        super.destroy();
    }

    public static probe(buffer: ArrayBuffer) {
        let data = new Uint8Array(buffer);
        let sync_offset = -1;
        let ts_packet_size = 188;

        if (data.byteLength <= 3 * ts_packet_size) {
            Log.e("TSDemuxer", `Probe data ${data.byteLength} bytes is too few for judging MPEG-TS stream format!`);
            return {match: false};
        }

        while (sync_offset === -1) {
            let scan_window = Math.min(1000, data.byteLength - 3 * ts_packet_size);

            for (let i = 0; i < scan_window; ) {
                // sync_byte should all be 0x47
                if (data[i] === 0x47
                        && data[i + ts_packet_size] === 0x47
                        && data[i + 2 * ts_packet_size] === 0x47) {
                    sync_offset = i;
                    break;
                } else {
                    i++;
                }
            }

            // find sync_offset failed in previous ts_packet_size
            if (sync_offset === -1) {
                if (ts_packet_size === 188) {
                    // try 192 packet size (BDAV, etc.)
                    ts_packet_size = 192;
                } else {
                    // 192 also failed, exit
                    break;
                }
            }
        }

        if (sync_offset === -1) {
            // both 188 / 192 failed, Non MPEG-TS
            return {match: false};
        }

        return {
            match: true,
            consumed: 0,
            ts_packet_size,
            sync_offset
        };
    }

    public bindDataSource(loader) {
        loader.onDataArrival = this.parseChunks.bind(this);
        return this;
    }

    public resetMediaInfo() {
        this.media_info_ = new MediaInfo();
    }

    private isInitialMetadataDispatched() {
        return false;
    }

    public parseChunks(chunk: ArrayBuffer, byteStart: number): number {
        if (!this.onError
                || !this.onMediaInfo
                || !this.onTrackMetadata
                || !this.onDataAvailable) {
            throw new IllegalStateException('onError & onMediaInfo & onTrackMetadata & onDataAvailable callback must be specified');
        }

        let offset = this.sync_offset_;

        while (offset + this.ts_packet_size_ <= chunk.byteLength) {
            let v = new DataView(chunk, offset, this.ts_packet_size_);

            let sync_byte = v.getUint8(0);
            if (sync_byte !== 0x47) {
                Log.e(this.TAG, `sync_byte = ${sync_byte}, not 0x47`);
                break;
            }

            let payload_unit_start_indicator = (v.getUint8(1) & 0x40) >>> 6;
            let transport_priority = (v.getUint8(1) & 0x20) >>> 5;
            let pid = ((v.getUint8(1) & 0x1F) << 8) | v.getUint8(2);
            let adaptation_field_control = (v.getUint8(3) & 0x30) >>> 4;
            let continuity_conunter = (v.getUint8(3) & 0x0F);

            let ts_payload_start_index = 4;

            if (adaptation_field_control == 0x02 || adaptation_field_control == 0x03) {
                let adaptation_field_length = v.getUint8(4);
                if (5 + adaptation_field_length === this.ts_packet_size_) {
                    // TS packet only has adaption field, jump to next
                    offset += this.ts_packet_size_;
                    continue;
                } else {
                    ts_payload_start_index = 4 + 1 + adaptation_field_length;
                }
            }

            if (adaptation_field_control == 0x01 || adaptation_field_control == 0x03) {
                if (pid === 0 || pid === this.current_pmt_pid_) {  // PAT(pid === 0) or PMT
                    if (payload_unit_start_indicator) {
                        let pointer_field = v.getUint8(ts_payload_start_index);
                        // skip pointer_field and strange data
                        ts_payload_start_index += 1 + pointer_field;
                    }
                    let ts_payload_length = this.ts_packet_size_ - ts_payload_start_index;

                    if (pid === 0) {
                        this.parsePAT(chunk,
                                      offset + ts_payload_start_index,
                                      ts_payload_length,
                                      {payload_unit_start_indicator, continuity_conunter});
                    } else {
                        this.parsePMT(chunk,
                                      offset + ts_payload_start_index,
                                      ts_payload_length,
                                      {payload_unit_start_indicator, continuity_conunter});
                    }
                } else if (this.pmt_ != undefined && this.pmt_.pid_stream_type[pid] != undefined) {
                    // PES
                    let ts_payload_length = this.ts_packet_size_ - ts_payload_start_index;
                    let stream_type = this.pmt_.pid_stream_type[pid];

                    // process PES only for known common_pids
                    if (pid === this.pmt_.common_pids.h264
                            || pid === this.pmt_.common_pids.adts_aac
                            || this.pmt_.pes_private_data_pids[pid] === true) {
                        this.handlePESSlice(chunk,
                                            offset + ts_payload_start_index,
                                            ts_payload_length,
                                            {pid, stream_type, payload_unit_start_indicator, continuity_conunter});
                    }
                }
            }

            offset += this.ts_packet_size_;
        }

        // dispatch parsed frames to the remuxer (consumer)
        if (this.isInitialMetadataDispatched()) {
            if (this.do_dispatch_ && (this.audio_track_.length || this.video_track_.length)) {
                this.onDataAvailable(this.audio_track_, this.video_track_);
            }
        }

        return offset;  // consumed bytes
    }

    private parsePAT(buffer: ArrayBuffer, offset: number, length: number, misc: any): void {
        let data = new Uint8Array(buffer, offset, length);

        let table_id = data[0];
        if (table_id !== 0x00) {
            Log.e(this.TAG, `parsePAT: table_id ${table_id} is not corresponded to PAT!`);
            return;
        }

        let section_length = ((data[1] & 0x0F) << 8) | data[2];

        let transport_stream_id = (data[3] << 8) | data[4];
        let version_number = (data[5] & 0x3E) >>> 1;
        let current_next_indicator = data[5] & 0x01;
        let section_number = data[6];
        let last_section_number = data[7];

        if (current_next_indicator === 1 && section_number === 0) {
            this.pat_ = new PAT();
            this.pat_.version_number = version_number;
        } else {
            if (this.pat_ == undefined) {
                return;
            }
        }

        let program_start_index = 8;
        let program_bytes = section_length - 5 - 4;  // section_length - (headers + crc)
        let first_program_number = -1;
        let first_pmt_pid = -1;

        for (let i = program_start_index; i < program_start_index + program_bytes; i += 4) {
            let program_number = (data[i] << 8) | data[i + 1];
            let pid = ((data[i + 2] & 0x1F) << 8) | data[i + 3];

            if (program_number === 0) {
                // network_PID
                this.pat_.network_pid = pid;
            } else {
                // program_map_PID
                this.pat_.program_pmt_pid[program_number] = pid;

                if (first_program_number === -1) {
                    first_program_number = program_number;
                }

                if (first_pmt_pid === -1) {
                    first_pmt_pid = pid;
                }
            }
        }

        // Currently we only deal with first appeared PMT pid
        if (current_next_indicator === 1 && section_number === 0) {
            this.current_program_ = first_program_number;
            this.current_pmt_pid_ = first_pmt_pid;
            // Log.v(this.TAG, `PAT: ${JSON.stringify(this.pat_)}`);
        }
    }

    private parsePMT(buffer: ArrayBuffer, offset: number, length: number, misc: any): void {
        let data = new Uint8Array(buffer, offset, length);

        let table_id = data[0];
        if (table_id !== 0x02) {
            Log.e(this.TAG, `parsePMT: table_id ${table_id} is not corresponded to PMT!`);
            return;
        }

        let section_length = ((data[1] & 0x0F) << 8) | data[2];

        let program_number = (data[3] << 8) | data[4];
        let version_number = (data[5] & 0x3E) >>> 1;
        let current_next_indicator = data[5] & 0x01;
        let section_number = data[6];
        let last_section_number = data[7];

        let pmt: PMT = null;

        if (current_next_indicator === 1 && section_number === 0) {
            pmt = new PMT();
            pmt.program_number = program_number;
            pmt.version_number = version_number;
            this.program_pmt_map_[program_number] = pmt;
        } else {
            pmt = this.program_pmt_map_[program_number];
            if (pmt == undefined) {
                return;
            }
        }

        let PCR_PID = ((data[8] & 0x1F) << 8) | data[9];
        let program_info_length = ((data[10] & 0x0F) << 8) | data[11];

        let info_start_index = 12 + program_info_length;
        let info_bytes = section_length - 9 - program_info_length - 4;

        for (let i = info_start_index; i < info_start_index + info_bytes; ) {
            let stream_type = data[i] as StreamType;
            let elementary_PID = ((data[i + 1] & 0x1F) << 8) | data[i + 2];

            pmt.pid_stream_type[elementary_PID] = stream_type;

            if (stream_type === StreamType.kH264 && !pmt.common_pids.h264) {
                pmt.common_pids.h264 = elementary_PID;
            } else if (stream_type === StreamType.kADTSAAC && !pmt.common_pids.adts_aac) {
                pmt.common_pids.adts_aac = elementary_PID;
            } else if (stream_type === StreamType.kPESPrivateData) {
                pmt.pes_private_data_pids[elementary_PID] = true;
            }

            let ES_info_length = ((data[i + 3] & 0x0F) << 8) | data[i + 4];
            i += 5 + ES_info_length;
        }

        if (program_number === this.current_program_) {
            this.pmt_ = pmt;
            // Log.v(this.TAG, `PMT: ${JSON.stringify(pmt)}`);
        }
    }

    private handlePESSlice(buffer: ArrayBuffer, offset: number, length: number, misc: any): void {
        let data = new Uint8Array(buffer, offset, length);

        let packet_start_code_prefix = (data[0] << 16) | (data[1] << 8) | (data[2]);
        let stream_id = data[3];
        let PES_packet_length = (data[4] << 8) | data[5];

        if (misc.payload_unit_start_indicator) {
            if (packet_start_code_prefix !== 1) {
                Log.e(this.TAG, `handlePESSlice: packet_start_code_prefix should be 1 but with value ${packet_start_code_prefix}`);
                return;
            }

            // handle queued PES slices:
            // Merge into a big Uint8Array then call parsePES()
            let pes_queue = this.pid_pes_queues_[misc.pid];
            if (pes_queue) {
                let pes = new Uint8Array(pes_queue.total_length);
                for (let i = 0, offset = 0; i < pes_queue.slices.length; i++) {
                    let slice = pes_queue.slices[i];
                    pes.set(slice, offset);
                    offset += slice.byteLength;
                }
                pes_queue.slices = [];
                pes_queue.total_length = 0;
                this.parsePES(pes, misc);
            }

            // Make a new PES queue for new PES slices
            this.pid_pes_queues_[misc.pid] = new PESQueue();
        }

        if (this.pid_pes_queues_[misc.pid] == undefined) {
            // ignore PES slices without [PES slice that has payload_unit_start_indicator]
            return;
        }

        // push subsequent PES slices into pes_queue
        let pes_queue = this.pid_pes_queues_[misc.pid];
        pes_queue.slices.push(data);
        pes_queue.total_length += data.byteLength;
    }

    private parsePES(data: Uint8Array, misc: any): void {
        let packet_start_code_prefix = (data[0] << 16) | (data[1] << 8) | (data[2]);
        let stream_id = data[3];
        let PES_packet_length = (data[4] << 8) | data[5];

        if (packet_start_code_prefix !== 1) {
            Log.e(this.TAG, `parsePES: packet_start_code_prefix should be 1 but with value ${packet_start_code_prefix}`);
            return;
        }

        if (stream_id !== 0xBC  // program_stream_map
                && stream_id !== 0xBE  // padding_stream
                && stream_id !== 0xBF  // private_stream_2
                && stream_id !== 0xF0  // ECM
                && stream_id !== 0xF1  // EMM
                && stream_id !== 0xFF  // program_stream_directory
                && stream_id !== 0xF2  // DSMCC
                && stream_id !== 0xF8) {
            let PES_scrambling_control = (data[6] & 0x30) >>> 4;
            let PTS_DTS_flags = (data[7] & 0xC0) >>> 6;
            let PES_header_data_length = data[8];

            let pts: number | undefined;
            let dts: number | undefined;

            if (PTS_DTS_flags === 0x02 || PTS_DTS_flags === 0x03) {
                pts = (data[9] & 0x0E) * 536870912 + // 1 << 29
                      (data[10] & 0xFF) * 4194304 + // 1 << 22
                      (data[11] & 0xFE) * 16384 + // 1 << 14
                      (data[12] & 0xFF) * 128 + // 1 << 7
                      (data[13] & 0xFE) / 2;

                if (PTS_DTS_flags === 0x03) {
                    dts = (data[14] & 0x0E) * 536870912 + // 1 << 29
                          (data[15] & 0xFF) * 4194304 + // 1 << 22
                          (data[16] & 0xFE) * 16384 + // 1 << 14
                          (data[17] & 0xFF) * 128 + // 1 << 7
                          (data[18] & 0xFE) / 2;
                } else {
                    dts = pts;
                }
            }

            let payload_start_index = 6 + 3 + PES_header_data_length;
            let payload_length: number;

            if (PES_packet_length !== 0) {
                if (PES_packet_length < 3 + PES_header_data_length) {
                    Log.v(this.TAG, `Malformed PES: PES_packet_length < 3 + PES_header_data_length`);
                    return;
                }
                payload_length = PES_packet_length - 3 - PES_header_data_length;
            } else {  // PES_packet_length === 0
                payload_length = data.byteLength - payload_start_index;
            }

            let payload = new Uint8Array(data, payload_start_index, payload_length);

            switch (misc.stream_type) {
                case StreamType.kMPEG1Audio:
                case StreamType.kMPEG2Audio:
                    break;
                case StreamType.kPESPrivateData:
                    break;
                case StreamType.kADTSAAC:
                    this.parseAACPayload(payload, pts, dts, misc);
                    break;
                case StreamType.kID3:
                    break;
                case StreamType.kH264:
                    this.parseH264Payload(payload, pts, dts, misc);
                    break;
                case StreamType.kH265:
                default:
                    break;
            }
        }
    }

    private parseH264Payload(data: Uint8Array, pts: number, dts: number, misc: any) {

    }

    private parseAACPayload(data: Uint8Array, pts: number, dts: number, misc: any) {

    }

}

export default TSDemuxer;
