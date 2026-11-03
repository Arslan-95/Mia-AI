#import "MiaAudioBridge.h"
#import <stdatomic.h>

static NSString *const MiaDiagnosticsKey = @"MiaVoice.nativeDiagnostics";
static atomic_uint MiaLastCopyFailure = 0;

@interface MiaInputTrace : NSObject {
  atomic_bool _observed;
}
- (BOOL)markFirstInput;
@end
@implementation MiaInputTrace
- (instancetype)init {
  self = [super init];
  if (self) atomic_init(&_observed, NO);
  return self;
}
- (BOOL)markFirstInput {
  return !atomic_exchange_explicit(&_observed, YES, memory_order_relaxed);
}
@end
static void MiaRecord(NSString *stage, NSDictionary *detail) {
  @synchronized (MiaAudioBridge.class) {
    NSMutableArray *events = [[[NSUserDefaults standardUserDefaults] arrayForKey:MiaDiagnosticsKey] mutableCopy] ?: [NSMutableArray array];
    NSMutableDictionary *event = [@{@"stage": stage, @"time": @([[NSDate date] timeIntervalSince1970] * 1000)} mutableCopy];
    [event addEntriesFromDictionary:detail ?: @{}]; [events addObject:event];
    while (events.count > 30) [events removeObjectAtIndex:0];
    [[NSUserDefaults standardUserDefaults] setObject:events forKey:MiaDiagnosticsKey];
  }
}
static NSError *MiaFailure(NSString *stage, NSException *exception) {
  MiaRecord(stage, @{@"exception": exception.name, @"reason": exception.reason ?: @"Unknown audio exception", @"stack": [exception.callStackSymbols subarrayWithRange:NSMakeRange(0, MIN(8, exception.callStackSymbols.count))]});
  return [NSError errorWithDomain:@"MiaVoice" code:1 userInfo:@{NSLocalizedDescriptionKey: @"The audio engine could not complete this operation."}];
}
static NSError *MiaGuard(NSString *stage, void (^operation)(void)) {
  @try { operation(); return nil; }
  @catch (NSException *exception) { return MiaFailure(stage, exception); }
}
static AVAudioPCMBuffer *MiaCopyRejected(unsigned reason, AVAudioPCMBuffer *input) {
  // A recurring bad buffer must not write to preferences on every audio tick.
  if (atomic_exchange_explicit(&MiaLastCopyFailure, reason, memory_order_relaxed) != reason) {
    MiaRecord(@"copy_rejected", @{@"reason": @(reason), @"frames": @(input.frameLength), @"capacity": @(input.frameCapacity), @"channels": @(input.format.channelCount)});
  }
  return nil;
}

@implementation MiaAudioBridge {
  AVAudioConverter *_converter;
}
+ (NSError *)startEngine:(AVAudioEngine *)engine player:(AVAudioPlayerNode *)player tap:(AVAudioNodeTapBlock)tap {
  MiaRecord(@"configure_graph", @{});
  __block NSError *error = nil;
  NSError *exception = MiaGuard(@"configure_graph", ^{
    AVAudioInputNode *input = engine.inputNode;
    if (![input setVoiceProcessingEnabled:YES error:&error] || !input.isVoiceProcessingEnabled) {
      if (!error) error = [NSError errorWithDomain:@"MiaVoice" code:6 userInfo:nil];
      return;
    }
    input.voiceProcessingBypassed = NO;
    input.voiceProcessingInputMuted = NO;
    AVAudioFormat *format = [input inputFormatForBus:0];
    if (format.sampleRate <= 0 || format.channelCount == 0) {
      error = [NSError errorWithDomain:@"MiaVoice" code:2 userInfo:nil]; return;
    }
    MiaRecord(@"input_format", @{@"sampleRate": @(format.sampleRate), @"channels": @(format.channelCount)});
    [engine attachNode:player];
    [engine connect:player to:engine.mainMixerNode format:[[AVAudioFormat alloc] initStandardFormatWithSampleRate:24000 channels:1]];
    // Negotiate the tap with the actual input route. Conversion is created
    // from each delivered buffer format, not a guessed/preferred sample rate.
    MiaInputTrace *trace = [MiaInputTrace new];
    [input installTapOnBus:0 bufferSize:1024 format:nil block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
      if ([trace markFirstInput]) {
        MiaRecord(@"first_input", @{@"frames": @(buffer.frameLength), @"capacity": @(buffer.frameCapacity), @"channels": @(buffer.format.channelCount), @"sampleRate": @(buffer.format.sampleRate)});
      }
      tap(buffer, when);
    }];
    [engine prepare]; [engine startAndReturnError:&error];
  });
  // isRunning can temporarily turn false while VPIO finishes changing the
  // hardware graph. The owner handles that transition on its serial queue.
  if (exception || error) { MiaRecord(@"start_failed", @{@"code": @((exception ?: error).code)}); return exception ?: error; }
  MiaRecord(@"start_requested", @{@"running": @(engine.isRunning), @"voiceProcessing": @(engine.inputNode.isVoiceProcessingEnabled), @"bypassed": @(engine.inputNode.isVoiceProcessingBypassed), @"inputMuted": @(engine.inputNode.isVoiceProcessingInputMuted)}); return nil;
}
+ (NSError *)resumeEngine:(AVAudioEngine *)engine {
  __block NSError *error = nil;
  NSError *exception = MiaGuard(@"resume_graph", ^{
    // The I/O unit may stop the graph while completing a route/format change.
    // Preserve the active session, connections and tap, as in Apple's
    // AVEchoTouch configuration-change handler. Our mixer tracks output
    // hardware, and input conversion tracks the delivered buffer format.
    if (!engine.isRunning) [engine startAndReturnError:&error];
  });
  if (!exception && !error && !engine.isRunning) error = [NSError errorWithDomain:@"MiaVoice" code:7 userInfo:nil];
  MiaRecord(exception || error ? @"resume_failed" : @"resumed", @{@"running": @(engine.isRunning), @"code": @((exception ?: error).code)});
  return exception ?: error;
}
+ (NSError *)stopPlayer:(AVAudioPlayerNode *)player {
  return MiaGuard(@"stop_player", ^{ [player stop]; });
}
+ (NSError *)stopEngine:(AVAudioEngine *)engine player:(AVAudioPlayerNode *)player tapped:(BOOL)tapped {
  NSError *failure = [self stopPlayer:player];
  if (tapped && engine) { NSError *error = MiaGuard(@"remove_tap", ^{ [engine.inputNode removeTapOnBus:0]; }); if (!failure) failure = error; }
  NSError *error = MiaGuard(@"stop_engine", ^{ [engine stop]; [engine reset]; }); if (!failure) failure = error;
  MiaRecord(@"stopped", @{}); return failure;
}
+ (NSError *)playPCM:(NSData *)data player:(AVAudioPlayerNode *)player completion:(void (^)(void))completion {
  if (data.length == 0 || data.length % 2 || data.length > 12000000) return [NSError errorWithDomain:@"MiaVoice" code:4 userInfo:nil];
  MiaRecord(@"schedule_playback", @{@"bytes": @(data.length)});
  __block NSError *allocationError = nil;
  NSError *exception = MiaGuard(@"schedule_playback", ^{
    AVAudioFormat *format = [[AVAudioFormat alloc] initStandardFormatWithSampleRate:24000 channels:1];
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:(AVAudioFrameCount)(data.length / 2)];
    if (!buffer || !buffer.floatChannelData || !buffer.floatChannelData[0]) { allocationError = [NSError errorWithDomain:@"MiaVoice" code:5 userInfo:nil]; return; }
    buffer.frameLength = (AVAudioFrameCount)(data.length / 2);
    const uint8_t *bytes = data.bytes; float *samples = buffer.floatChannelData[0];
    for (NSUInteger i = 0; i < buffer.frameLength; i++) samples[i] = (float)(int16_t)((uint16_t)bytes[i * 2] | ((uint16_t)bytes[i * 2 + 1] << 8)) / 32768.0f;
    [player scheduleBuffer:buffer atTime:nil options:0 completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType type) { completion(); }];
    [player play];
  });
  return exception ?: allocationError;
}
+ (AVAudioPCMBuffer *)copyInput:(AVAudioPCMBuffer *)input {
  if (!input || input.frameLength == 0 || input.frameLength > input.frameCapacity || input.frameLength > 65536) return MiaCopyRejected(1, input);
  @try {
    AVAudioPCMBuffer *copy = [[AVAudioPCMBuffer alloc] initWithPCMFormat:input.format frameCapacity:input.frameLength];
    if (!copy) return MiaCopyRejected(2, input);
    copy.frameLength = input.frameLength;
    const AudioBufferList *source = input.audioBufferList; AudioBufferList *target = copy.mutableAudioBufferList;
    if (!source || !target) return MiaCopyRejected(3, input);
    if (source->mNumberBuffers != target->mNumberBuffers) return MiaCopyRejected(4, input);
    UInt32 bytes = input.frameLength * input.format.streamDescription->mBytesPerFrame;
    for (UInt32 i = 0; i < source->mNumberBuffers; i++) {
      if (!source->mBuffers[i].mData || !target->mBuffers[i].mData || source->mBuffers[i].mDataByteSize < bytes || target->mBuffers[i].mDataByteSize < bytes) return MiaCopyRejected(5, input);
      memcpy(target->mBuffers[i].mData, source->mBuffers[i].mData, bytes);
    }
    atomic_store_explicit(&MiaLastCopyFailure, 0, memory_order_relaxed);
    return copy;
  } @catch (NSException *exception) { MiaFailure(@"copy_input", exception); return nil; }
}
- (NSData *)convertInput:(AVAudioPCMBuffer *)input {
  @try {
    AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:24000 channels:1 interleaved:YES];
    if (!_converter || ![_converter.inputFormat isEqual:input.format]) {
      _converter = [[AVAudioConverter alloc] initFromFormat:input.format toFormat:format];
      MiaRecord(@"converter_format", @{@"sampleRate": @(input.format.sampleRate), @"channels": @(input.format.channelCount)});
    }
    if (!_converter || input.format.sampleRate <= 0) return nil;
    AVAudioFrameCount capacity = (AVAudioFrameCount)ceil(input.frameLength * 24000.0 / input.format.sampleRate) + 32;
    AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:capacity];
    if (!output) return nil;
    __block BOOL supplied = NO; NSError *error = nil;
    AVAudioConverterOutputStatus status = [_converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets, AVAudioConverterInputStatus *state) {
      if (supplied) { *state = AVAudioConverterInputStatus_NoDataNow; return nil; }
      supplied = YES; *state = AVAudioConverterInputStatus_HaveData; return input;
    }];
    if (status == AVAudioConverterOutputStatus_Error || error) { MiaRecord(@"conversion_failed", @{@"code": @(error.code)}); return nil; }
    if (output.frameLength == 0) return [NSData data];
    const AudioBufferList *list = output.audioBufferList;
    NSUInteger bytes = (NSUInteger)output.frameLength * 2;
    if (!list || list->mNumberBuffers != 1 || !list->mBuffers[0].mData || list->mBuffers[0].mDataByteSize < bytes) return nil;
    return [NSData dataWithBytes:list->mBuffers[0].mData length:bytes];
  } @catch (NSException *exception) { MiaFailure(@"convert_input", exception); return nil; }
}
- (void)reset { _converter = nil; }
+ (NSDictionary<NSString *,id> *)diagnostics {
  return @{@"apiVersion": @3, @"implementation": @"epoch-audio-4", @"events": [[NSUserDefaults standardUserDefaults] arrayForKey:MiaDiagnosticsKey] ?: @[]};
}
+ (void)recordEvent:(NSString *)stage detail:(NSDictionary<NSString *, id> *)detail { MiaRecord(stage, detail); }
@end
