// Development-only real-file probe. Mirrors product tier fallback and verifies
// contributions after stretch/effects/envelopes, without a device or model run.
void inspectAutoMixMusicPair(const std::string& file,const std::string& waveFile) {
  const auto text=readTextFile(pathFromUtf8Bytes(file));char parseError[256]{};
  std::unique_ptr<am_json,decltype(&am_json_free)> root(am_json_parse(text.c_str(),parseError,sizeof parseError),am_json_free);
  if(!root)throw std::runtime_error(parseError);
  const auto feature=[&](const char* side) {
    auto* encoded=am_json_encode(am_jget(root.get(),side));
    if(!encoded)throw std::runtime_error("invalid_pair_features");
    std::string result(encoded);std::free(encoded);return result;
  };
  TAE_AM_ConfigV1 config{};TAE_AM_DefaultConfig(&config);
  const auto pool=twilight::automix::generateCandidates(config,
    am_jnum(am_jget(am_jget(root.get(),"outgoing"),"durationSeconds"),0),
    am_jnum(am_jget(am_jget(root.get(),"incoming"),"durationSeconds"),0),feature("outgoing"),feature("incoming"));
  constexpr unsigned rate=48000,channels=2;
  AudioFormat format{};format.sampleRate=rate;format.channelCount=channels;
  format.bitDepth=32;format.sampleFormat=AudioSampleFormat::Float32Interleaved;
  unsigned maximumTier=3;
  for(;;) {
    const auto index=twilight::automix::selectCandidate(pool,0,maximumTier);
    const auto& quality=pool.quality[index];const auto candidate=twilight::automix::candidateForRendering(pool,index);
    TAE_AM_Plan plan{};TAE_AM_Prepared prepared{};
    struct Guard {TAE_AM_Plan& plan;TAE_AM_Prepared& pcm;~Guard(){TAE_AM_DestroyPrepared(pcm);TAE_AM_DestroyPlan(plan);}} guard{plan,prepared};
    if(TAE_AM_Compile(&config,&candidate,&plan)!=TAE_AM_OK)throw std::runtime_error("probe_compile_failed");
    std::vector<float> pcm[2];TAE_AM_PcmViewV1 views[2];
    for(unsigned side=0;side<2;++side) {
      TAE_AM_SourceWindowV1 window{sizeof window,TAE_AM_ABI_VERSION};
      if(TAE_AM_GetSourceWindow(plan,side,rate,&window)!=TAE_AM_OK)throw std::runtime_error("probe_source_range_failed");
      const auto source=am_jstr(am_jget(root.get(),side?"incomingSource":"outgoingSource"),"");
      FFmpegDecoder decoder;std::string error;
      if(!decoder.open(source,&error)||!decoder.setOutputFormat(format,&error)||!decoder.seekOutputFrame(window.source_first_frame,&error))throw std::runtime_error(error);
      pcm[side].resize(window.frames*channels);uint64_t cursor=0;
      while(cursor<window.frames) {
        error.clear();const auto count=decoder.readFrames(pcm[side].data()+cursor*channels,std::min<uint64_t>(2048,window.frames-cursor),&error);
        if(!count) {
          if(error.empty()&&decoder.eof()&&window.source_first_frame+cursor>=window.nominal_end_frame)break;
          throw std::runtime_error("probe_incomplete_decode:"+error);
        }
        cursor+=count;
      }
      views[side]={sizeof(TAE_AM_PcmViewV1),TAE_AM_ABI_VERSION,pcm[side].data(),window.frames,window.source_first_frame,rate,channels};
    }
    TAE_AM_PreparedInfoV1 info{sizeof info,TAE_AM_ABI_VERSION};
    TAE_AM_MixEvidenceV1 evidence{sizeof evidence,TAE_AM_ABI_VERSION};
    if(TAE_AM_Prepare(plan,&views[0],&views[1],1,1,&prepared,&info)!=TAE_AM_OK)throw std::runtime_error("probe_prepare_failed");
    if(TAE_AM_InspectPrepared(prepared,&evidence)!=TAE_AM_OK)throw std::runtime_error("probe_evidence_failed");
    if(quality.tier>=2&&(evidence.audible_overlap_seconds<2||evidence.longest_overlap_seconds<1)) {
      std::cerr<<"prepared tier "<<quality.tier<<" declined: overlap="<<evidence.audible_overlap_seconds
        <<" continuous="<<evidence.longest_overlap_seconds<<"\n";
      maximumTier=quality.tier-1;continue;
    }
    std::vector<float> mixed(info.frames*channels);
    if(TAE_AM_MixPrepared(prepared,0,mixed.data(),info.frames)!=info.frames)throw std::runtime_error("probe_render_failed");
    if(!std::all_of(mixed.begin(),mixed.end(),[](float x){return std::isfinite(x);}))throw std::runtime_error("probe_nonfinite_pcm");
    if(!waveFile.empty()) {
      std::ofstream wave(pathFromUtf8Bytes(waveFile),std::ios::binary);
      const auto u32=[&](uint32_t x){wave.write(reinterpret_cast<const char*>(&x),4);};
      const auto u16=[&](uint16_t x){wave.write(reinterpret_cast<const char*>(&x),2);};
      const uint32_t bytes=static_cast<uint32_t>(mixed.size()*2);
      wave.write("RIFF",4);u32(36+bytes);wave.write("WAVEfmt ",8);u32(16);
      u16(1);u16(channels);u32(rate);u32(rate*channels*2);u16(channels*2);u16(16);
      wave.write("data",4);u32(bytes);
      // Fixed -6 dB preview gain only. Eligibility evidence uses original gain.
      for(float x:mixed) {const auto y=static_cast<int16_t>(std::round(std::clamp(x*.5f,-1.f,1.f)*32767));u16(static_cast<uint16_t>(y));}
      if(!wave)throw std::runtime_error("probe_wave_write_failed");
    }
    std::cout<<std::setprecision(15)<<"{\"mixTier\":"<<quality.tier<<",\"styleId\":"<<info.style_id
      <<",\"tempoRatio\":"<<quality.tempoRatio<<",\"transitionSeconds\":"<<info.transition_seconds
      <<",\"audibleOverlapSeconds\":"<<evidence.audible_overlap_seconds
      <<",\"longestOverlapSeconds\":"<<evidence.longest_overlap_seconds
      <<",\"incomingResumeSeconds\":"<<double(info.incoming_resume_frame)/rate
      <<",\"outgoingEndSeconds\":"<<double(info.outgoing_end_frame)/rate
      <<",\"wavePreviewGain\":0.5,\"finitePcm\":true,\"listeningRated\":false}\n";
    return;
  }
}
